package dev.steward.lab;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class FeedbackConfigTest {
    @Test void acceptsDiscordCredentialsForThePublicSite() {
        FeedbackConfig config = new FeedbackConfig(
            "https://am4.tail8e749c.ts.net/world/",
            "123456789012345678", "secret",
            "https://discord.com/api/webhooks/123456/token",
            "987654321098765432");
        assertDoesNotThrow(config::validateForPublic);
    }

    @Test void allowsLoopbackHttpForLocalPublicSmokeTests() {
        FeedbackConfig config = new FeedbackConfig(
            "http://127.0.0.1:8092/",
            "123456789012345678", "secret",
            "https://discord.com/api/webhooks/123456/token",
            "987654321098765432");
        assertDoesNotThrow(config::validateForPublic);
    }

    @Test void rejectsNonDiscordWebhookHosts() {
        FeedbackConfig config = new FeedbackConfig(
            "https://am4.tail8e749c.ts.net/world/",
            "123456789012345678", "secret",
            "https://example.com/api/webhooks/123456/token",
            "987654321098765432");
        assertThrows(IllegalArgumentException.class, config::validateForPublic);
    }
}
