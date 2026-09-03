package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class JobManager implements AutoCloseable {
    private final LensRenderer renderer;
    private final ObjectMapper mapper;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "spatial-lab-render");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, LabJob> jobs = new ConcurrentHashMap<>();

    public JobManager(LensRenderer renderer, ObjectMapper mapper) {
        this.renderer = renderer;
        this.mapper = mapper;
    }

    public LabJob submit(LabJob.RenderRequest rawRequest) {
        LabJob.RenderRequest request = rawRequest.normalized();
        LabJob job = new LabJob("render", request);
        jobs.put(job.id(), job);
        Future<?> future = executor.submit(() -> execute(job));
        job.attachFuture(future);
        return job;
    }

    public LabJob runBlocking(LabJob.RenderRequest request) {
        LabJob job = new LabJob("render", request.normalized());
        jobs.put(job.id(), job);
        execute(job);
        return job;
    }

    private void execute(LabJob job) {
        if (job.status() == LabJob.Status.CANCELLED) return;
        try {
            renderer.render(job);
        } catch (LabJob.JobCancelledException cancelled) {
            job.markCancelled();
        } catch (Throwable failure) {
            job.fail(failure);
        }
    }

    public LabJob require(String id) {
        LabJob job = jobs.get(id);
        if (job == null) throw new IllegalArgumentException("Job not found: " + id);
        return job;
    }

    public ArrayNode jobsJson() {
        ArrayNode result = mapper.createArrayNode();
        List<LabJob> sorted = new ArrayList<>(jobs.values());
        sorted.sort(Comparator.comparingLong(LabJob::queuedAtMs).reversed());
        sorted.stream().limit(30).forEach(job -> result.add(job.toJson(mapper)));
        return result;
    }

    @Override public void close() {
        executor.shutdownNow();
    }
}
