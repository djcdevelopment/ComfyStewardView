package dev.steward.lab;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

final class SlidingWindowRateLimiter {
    private static final int MAX_KEYS = 10_000;
    private static final String OVERFLOW_KEY = "__overflow__";
    private final int limit;
    private final long windowMillis;
    private final Map<String, ArrayDeque<Long>> attempts = new ConcurrentHashMap<>();
    private final AtomicLong acquisitions = new AtomicLong();

    SlidingWindowRateLimiter(int limit, Duration window) {
        if (limit <= 0 || window.isNegative() || window.isZero()) {
            throw new IllegalArgumentException("Rate limit and window must be positive");
        }
        this.limit = limit;
        this.windowMillis = window.toMillis();
    }

    Result acquire(String key) {
        long now = System.currentTimeMillis();
        if ((acquisitions.incrementAndGet() & 255) == 0) cleanup(now);
        if (!attempts.containsKey(key) && attempts.size() >= MAX_KEYS) key = OVERFLOW_KEY;
        ArrayDeque<Long> timestamps = attempts.computeIfAbsent(key, ignored -> new ArrayDeque<>());
        synchronized (timestamps) {
            long cutoff = now - windowMillis;
            while (!timestamps.isEmpty() && timestamps.peekFirst() <= cutoff) timestamps.removeFirst();
            if (timestamps.size() >= limit) {
                long retryMillis = Math.max(1, timestamps.peekFirst() + windowMillis - now);
                return new Result(false, Math.max(1, (retryMillis + 999) / 1000));
            }
            timestamps.addLast(now);
            return new Result(true, 0);
        }
    }

    private void cleanup(long now) {
        long cutoff = now - windowMillis;
        attempts.forEach((key, timestamps) -> {
            synchronized (timestamps) {
                while (!timestamps.isEmpty() && timestamps.peekFirst() <= cutoff) timestamps.removeFirst();
                if (timestamps.isEmpty()) attempts.remove(key, timestamps);
            }
        });
    }

    record Result(boolean allowed, long retryAfterSeconds) {}
}
