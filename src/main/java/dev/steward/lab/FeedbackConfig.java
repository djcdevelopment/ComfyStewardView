package dev.steward.lab;

import java.net.URI;
import java.util.Locale;

public record FeedbackConfig(
        String publicUrl,
        String discordClientId,
        String discordClientSecret,
        String discordWebhookUrl,
        String ownerUserId) {

    public static FeedbackConfig fromEnvironment(String publicUrl) {
        return new FeedbackConfig(publicUrl,
            environment("DISCORD_CLIENT_ID"),
            environment("DISCORD_CLIENT_SECRET"),
            environment("DISCORD_FEEDBACK_WEBHOOK_URL"),
            environment("DISCORD_OWNER_USER_ID"));
    }

    public boolean feedbackEnabled() {
        return !discordWebhookUrl.isBlank() && !ownerUserId.isBlank();
    }

    public boolean identityEnabled() {
        return feedbackEnabled() && !discordClientId.isBlank() && !discordClientSecret.isBlank();
    }

    public void validateForPublic() {
        URI page = absoluteUri(publicUrl, "Public URL");
        String scheme = page.getScheme().toLowerCase(Locale.ROOT);
        boolean loopbackHttp = "http".equals(scheme) && isLoopback(page.getHost());
        if (!"https".equals(scheme) && !loopbackHttp) {
            throw new IllegalArgumentException("Public URL must use HTTPS (HTTP is allowed only on loopback)");
        }
        if (page.getRawQuery() != null || page.getRawFragment() != null) {
            throw new IllegalArgumentException("Public URL cannot contain a query or fragment");
        }
        if (!identityEnabled()) {
            throw new IllegalArgumentException("Discord feedback and identity credentials are required in public mode");
        }
        if (!discordClientId.matches("[0-9]{5,30}")) {
            throw new IllegalArgumentException("DISCORD_CLIENT_ID must be a Discord snowflake ID");
        }
        if (!ownerUserId.matches("[0-9]{5,30}")) {
            throw new IllegalArgumentException("DISCORD_OWNER_USER_ID must be a Discord snowflake ID");
        }
        URI webhook = absoluteUri(discordWebhookUrl, "Discord feedback webhook URL");
        String host = webhook.getHost() == null ? "" : webhook.getHost().toLowerCase(Locale.ROOT);
        boolean discordHost = "discord.com".equals(host) || host.endsWith(".discord.com") ||
            "discordapp.com".equals(host) || host.endsWith(".discordapp.com");
        if (!"https".equalsIgnoreCase(webhook.getScheme()) || !discordHost ||
                webhook.getPath() == null || !webhook.getPath().startsWith("/api/webhooks/")) {
            throw new IllegalArgumentException("DISCORD_FEEDBACK_WEBHOOK_URL must be an HTTPS Discord webhook URL");
        }
    }

    public URI callbackUri() {
        return URI.create(publicUrl).resolve("api/auth/discord/callback");
    }

    public String cookiePath() {
        String path = URI.create(publicUrl).getPath();
        return path == null || path.isBlank() ? "/" : (path.endsWith("/") ? path : path + "/");
    }

    public boolean secureCookies() {
        return "https".equalsIgnoreCase(URI.create(publicUrl).getScheme());
    }

    private static String environment(String name) {
        String value = System.getenv(name);
        return value == null ? "" : value.trim();
    }

    private static URI absoluteUri(String value, String label) {
        try {
            URI uri = URI.create(value);
            if (!uri.isAbsolute() || uri.getHost() == null) throw new IllegalArgumentException();
            return uri;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException(label + " must be an absolute URL");
        }
    }

    private static boolean isLoopback(String host) {
        return "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "::1".equals(host);
    }
}
