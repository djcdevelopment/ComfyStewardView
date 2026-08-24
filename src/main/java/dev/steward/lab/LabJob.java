package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

public final class LabJob {
    public enum Status { QUEUED, RUNNING, COMPLETE, FAILED, CANCELLED }

    private final String id = UUID.randomUUID().toString();
    private final String type;
    private final RenderRequest request;
    private final long queuedAtMs = System.currentTimeMillis();
    private final List<Phase> phases = new ArrayList<>();
    private final ArrayDeque<String> logs = new ArrayDeque<>();
    private final Map<String, Object> metrics = new LinkedHashMap<>();
    private final AtomicBoolean cancelRequested = new AtomicBoolean();
    private volatile Status status = Status.QUEUED;
    private volatile long startedAtMs;
    private volatile long finishedAtMs;
    private volatile String currentPhase;
    private volatile String error;
    private volatile int completedUnits;
    private volatile int totalUnits;
    private volatile Future<?> future;

    public LabJob(String type, RenderRequest request) {
        this.type = type;
        this.request = request;
        log("Queued " + type + " job");
    }

    public String id() { return id; }
    public long queuedAtMs() { return queuedAtMs; }
    public RenderRequest request() { return request; }
    public boolean cancellationRequested() { return cancelRequested.get(); }
    public Status status() { return status; }

    public synchronized void attachFuture(Future<?> future) { this.future = future; }

    public synchronized void start(int totalUnits) {
        this.totalUnits = totalUnits;
        this.startedAtMs = System.currentTimeMillis();
        this.status = Status.RUNNING;
        log("Started with " + totalUnits + " layer(s)");
    }

    public synchronized Phase beginPhase(String name) {
        checkCancelled();
        Phase phase = new Phase(name, System.currentTimeMillis());
        phases.add(phase);
        currentPhase = name;
        log("START " + name);
        return phase;
    }

    public synchronized void completePhase(Phase phase, Map<String, Object> phaseMetrics) {
        phase.finish("complete", null, phaseMetrics);
        currentPhase = null;
        if (phaseMetrics != null) metrics.putAll(phaseMetrics);
        log("DONE  " + phase.name + " / " + phase.elapsedMs() + " ms");
    }

    public synchronized void failPhase(Phase phase, Throwable failure) {
        phase.finish("failed", failure.getMessage(), Map.of());
        currentPhase = null;
        log("FAIL  " + phase.name + " / " + failure.getMessage());
    }

    public synchronized void unitComplete() { completedUnits++; }

    public synchronized void complete() {
        status = Status.COMPLETE;
        finishedAtMs = System.currentTimeMillis();
        currentPhase = null;
        log("Complete in " + elapsedMs() + " ms");
    }

    public synchronized void fail(Throwable failure) {
        status = Status.FAILED;
        finishedAtMs = System.currentTimeMillis();
        currentPhase = null;
        error = failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
        log("Failed: " + error);
    }

    public synchronized void markCancelled() {
        status = Status.CANCELLED;
        finishedAtMs = System.currentTimeMillis();
        currentPhase = null;
        log("Cancelled");
    }

    public synchronized void cancel() {
        cancelRequested.set(true);
        log("Cancellation requested");
        if (status == Status.QUEUED && future != null && future.cancel(false)) markCancelled();
    }

    public void checkCancelled() {
        if (cancelRequested.get()) throw new JobCancelledException();
    }

    public synchronized void log(String message) {
        logs.addLast(Instant.now() + "  " + message);
        while (logs.size() > 160) logs.removeFirst();
    }

    public long elapsedMs() {
        if (startedAtMs == 0) return 0;
        return (finishedAtMs > 0 ? finishedAtMs : System.currentTimeMillis()) - startedAtMs;
    }

    public synchronized ObjectNode toJson(ObjectMapper mapper) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", id);
        node.put("type", type);
        node.put("status", status.name().toLowerCase());
        node.put("queuedAt", Instant.ofEpochMilli(queuedAtMs).toString());
        if (startedAtMs > 0) node.put("startedAt", Instant.ofEpochMilli(startedAtMs).toString());
        if (finishedAtMs > 0) node.put("finishedAt", Instant.ofEpochMilli(finishedAtMs).toString());
        node.put("elapsedMs", elapsedMs());
        node.put("currentPhase", currentPhase);
        node.put("completedUnits", completedUnits);
        node.put("totalUnits", totalUnits);
        node.put("cancelRequested", cancelRequested.get());
        if (error != null) node.put("error", error);
        node.set("request", mapper.valueToTree(request));
        ArrayNode phaseNodes = node.putArray("phases");
        phases.forEach(phase -> phaseNodes.add(phase.toJson(mapper)));
        node.set("metrics", mapper.valueToTree(metrics));
        ArrayNode logNodes = node.putArray("logs");
        logs.forEach(logNodes::add);
        return node;
    }

    public record RenderRequest(long snapshotId, List<String> lensIds, List<Integer> resolutions,
            boolean force, long simulatedDelayMs, int failAfterLayers) {
        public RenderRequest normalized() {
            return new RenderRequest(snapshotId,
                lensIds == null ? List.of() : List.copyOf(lensIds),
                resolutions == null ? List.of() : List.copyOf(resolutions),
                force, Math.max(0, Math.min(5_000, simulatedDelayMs)),
                Math.max(0, failAfterLayers));
        }
    }

    public static final class Phase {
        private final String name;
        private final long startedAtMs;
        private long finishedAtMs;
        private String status = "running";
        private String error;
        private Map<String, Object> metrics = Map.of();

        private Phase(String name, long startedAtMs) {
            this.name = name;
            this.startedAtMs = startedAtMs;
        }

        void finish(String status, String error, Map<String, Object> metrics) {
            this.finishedAtMs = System.currentTimeMillis();
            this.status = status;
            this.error = error;
            this.metrics = metrics == null ? Map.of() : Map.copyOf(metrics);
        }

        long elapsedMs() {
            return (finishedAtMs > 0 ? finishedAtMs : System.currentTimeMillis()) - startedAtMs;
        }

        ObjectNode toJson(ObjectMapper mapper) {
            ObjectNode node = mapper.createObjectNode();
            node.put("name", name);
            node.put("status", status);
            node.put("startedAt", Instant.ofEpochMilli(startedAtMs).toString());
            node.put("elapsedMs", elapsedMs());
            if (error != null) node.put("error", error);
            node.set("metrics", mapper.valueToTree(metrics));
            return node;
        }
    }

    public static final class JobCancelledException extends RuntimeException {
        JobCancelledException() { super("Job cancelled"); }
    }
}
