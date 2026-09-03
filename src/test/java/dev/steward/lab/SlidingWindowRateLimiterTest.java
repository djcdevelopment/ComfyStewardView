package dev.steward.lab;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.*;

class SlidingWindowRateLimiterTest {
    @Test void limitsEachClientIndependentlyAndReturnsRetryTime() {
        SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(2, Duration.ofMinutes(1));

        assertTrue(limiter.acquire("one").allowed());
        assertTrue(limiter.acquire("one").allowed());
        SlidingWindowRateLimiter.Result denied = limiter.acquire("one");
        assertFalse(denied.allowed());
        assertTrue(denied.retryAfterSeconds() > 0);
        assertTrue(limiter.acquire("two").allowed());
    }
}
