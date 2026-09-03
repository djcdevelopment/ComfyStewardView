package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

final class DiscordFeedbackService {
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(10);
    private static final long OAUTH_STATE_TTL_MS = Duration.ofMinutes(10).toMillis();
    private static final long IDENTITY_TTL_MS = Duration.ofHours(1).toMillis();
    private static final URI AUTHORIZE_ENDPOINT = URI.create("https://discord.com/oauth2/authorize");
    private static final URI TOKEN_ENDPOINT = URI.create("https://discord.com/api/v10/oauth2/token");
    private static final URI USER_ENDPOINT = URI.create("https://discord.com/api/v10/users/@me");

    private final FeedbackConfig config;
    private final ObjectMapper mapper;
    private final HttpClient http;
    private final URI authorizeEndpoint;
    private final URI tokenEndpoint;
    private final URI userEndpoint;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, OAuthState> states = new ConcurrentHashMap<>();
    private final Map<String, IdentitySession> sessions = new ConcurrentHashMap<>();

    DiscordFeedbackService(FeedbackConfig config, ObjectMapper mapper) {
        this(config, mapper, HttpClient.newBuilder().connectTimeout(REQUEST_TIMEOUT).build(),
            AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT, USER_ENDPOINT);
    }

    DiscordFeedbackService(FeedbackConfig config, ObjectMapper mapper, HttpClient http,
            URI authorizeEndpoint, URI tokenEndpoint, URI userEndpoint) {
        this.config = config;
        this.mapper = mapper;
        this.http = http;
        this.authorizeEndpoint = authorizeEndpoint;
        this.tokenEndpoint = tokenEndpoint;
        this.userEndpoint = userEndpoint;
    }

    Authorization beginAuthorization() {
        requireIdentityEnabled();
        cleanup();
        String state = token(24);
        String browserNonce = token(24);
        states.put(state, new OAuthState(browserNonce, System.currentTimeMillis() + OAUTH_STATE_TTL_MS));
        String query = "client_id=" + encode(config.discordClientId()) +
            "&response_type=code&scope=identify&redirect_uri=" + encode(config.callbackUri().toString()) +
            "&state=" + encode(state) + "&prompt=consent";
        return new Authorization(URI.create(authorizeEndpoint + "?" + query), browserNonce);
    }

    IdentitySession completeAuthorization(String code, String state, String browserNonce)
            throws IOException, InterruptedException {
        requireIdentityEnabled();
        cleanup();
        if (blank(code) || blank(state) || blank(browserNonce)) {
            throw new IllegalArgumentException("Discord authorization is incomplete");
        }
        OAuthState expected = states.remove(state);
        if (expected == null || expected.expiresAtMillis() < System.currentTimeMillis() ||
                !constantTimeEquals(expected.browserNonce(), browserNonce)) {
            throw new IllegalArgumentException("Discord authorization expired; please try again");
        }

        String form = "client_id=" + encode(config.discordClientId()) +
            "&client_secret=" + encode(config.discordClientSecret()) +
            "&grant_type=authorization_code&code=" + encode(code) +
            "&redirect_uri=" + encode(config.callbackUri().toString());
        HttpRequest tokenRequest = HttpRequest.newBuilder(tokenEndpoint)
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(form))
            .build();
        HttpResponse<String> tokenResponse = http.send(tokenRequest,
            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (tokenResponse.statusCode() / 100 != 2) {
            throw new IOException("Discord did not accept the authorization code");
        }
        String accessToken = mapper.readTree(tokenResponse.body()).path("access_token").asText("");
        if (accessToken.isBlank()) throw new IOException("Discord returned no access token");

        HttpRequest userRequest = HttpRequest.newBuilder(userEndpoint)
            .timeout(REQUEST_TIMEOUT)
            .header("Authorization", "Bearer " + accessToken)
            .header("Accept", "application/json")
            .GET().build();
        HttpResponse<String> userResponse = http.send(userRequest,
            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (userResponse.statusCode() / 100 != 2) {
            throw new IOException("Discord identity could not be read");
        }
        JsonNode user = mapper.readTree(userResponse.body());
        String id = user.path("id").asText("");
        String username = user.path("username").asText("");
        String globalName = user.path("global_name").asText("");
        if (!id.matches("[0-9]{5,30}") || username.isBlank()) {
            throw new IOException("Discord returned an invalid identity");
        }
        String displayName = globalName.isBlank() ? username : globalName;
        String sessionId = token(32);
        IdentitySession session = new IdentitySession(sessionId,
            new DiscordIdentity(id, username, displayName),
            System.currentTimeMillis() + IDENTITY_TTL_MS);
        sessions.put(sessionId, session);
        return session;
    }

    DiscordIdentity identity(String sessionId) {
        if (blank(sessionId)) return null;
        IdentitySession session = sessions.get(sessionId);
        if (session == null) return null;
        if (session.expiresAtMillis() < System.currentTimeMillis()) {
            sessions.remove(sessionId);
            return null;
        }
        return session.identity();
    }

    void logout(String sessionId) {
        if (!blank(sessionId)) sessions.remove(sessionId);
    }

    String submit(FeedbackRequest request, DiscordIdentity identity)
            throws IOException, InterruptedException {
        if (!config.feedbackEnabled()) throw new IllegalStateException("Feedback is not configured");
        String message = request == null || request.message() == null ? "" : request.message().trim();
        if (message.isEmpty()) throw new IllegalArgumentException("Tell us what you noticed first");
        if (message.length() > 2_000) throw new IllegalArgumentException("Feedback must be 2,000 characters or fewer");
        if (request.website() != null && !request.website().isBlank()) {
            throw new IllegalArgumentException("Feedback could not be submitted");
        }
        if (request.identify() && identity == null) {
            throw new IdentityRequiredException();
        }

        ObjectNode payload = mapper.createObjectNode();
        payload.put("content", "<@" + config.ownerUserId() + ">");
        ObjectNode allowed = payload.putObject("allowed_mentions");
        allowed.putArray("parse");
        allowed.putArray("users").add(config.ownerUserId());
        ArrayNode embeds = payload.putArray("embeds");
        ObjectNode embed = embeds.addObject();
        embed.put("title", "Steward World View feedback");
        embed.put("description", message);
        embed.put("color", 0xD5A83F);
        embed.put("timestamp", java.time.Instant.now().toString());
        ArrayNode fields = embed.putArray("fields");
        fields.addObject().put("name", "From")
            .put("value", request.identify() ? identityLabel(identity) : "Anonymous")
            .put("inline", true);

        JsonNode context = request.context();
        fields.addObject().put("name", "World")
            .put("value", contextValue(context, "world", "Comfy Era 17 · snapshot #107"))
            .put("inline", true);
        fields.addObject().put("name", "View")
            .put("value", contextValue(context, "view", "Build density"))
            .put("inline", false);
        String selection = contextValue(context, "selection", "No inspection area selected");
        fields.addObject().put("name", "Selection").put("value", selection).put("inline", false);
        String release = contextValue(context, "release", "unknown");
        embed.putObject("footer").put("text", "Steward " + release);

        URI webhook = waitWebhookUri(config.discordWebhookUrl());
        HttpRequest webhookRequest = HttpRequest.newBuilder(webhook)
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
            .build();
        HttpResponse<String> response = http.send(webhookRequest,
            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new IOException("Discord delivery failed with status " + response.statusCode());
        }
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private void requireIdentityEnabled() {
        if (!config.identityEnabled()) throw new IllegalStateException("Discord identity is not configured");
    }

    private void cleanup() {
        long now = System.currentTimeMillis();
        states.entrySet().removeIf(entry -> entry.getValue().expiresAtMillis() < now);
        sessions.entrySet().removeIf(entry -> entry.getValue().expiresAtMillis() < now);
    }

    private String token(int bytes) {
        byte[] value = new byte[bytes];
        random.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static String identityLabel(DiscordIdentity identity) {
        return cap(identity.displayName() + " (`@" + identity.username() + "` · " + identity.id() + ")", 1_024);
    }

    private static String contextValue(JsonNode context, String name, String fallback) {
        if (context == null || !context.isObject()) return fallback;
        String value = context.path(name).asText("").trim();
        return value.isEmpty() ? fallback : cap(value, 1_024);
    }

    private static URI waitWebhookUri(String raw) {
        return URI.create(raw + (raw.contains("?") ? "&" : "?") + "wait=true");
    }

    private static boolean constantTimeEquals(String left, String right) {
        return java.security.MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8),
            right.getBytes(StandardCharsets.UTF_8));
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String cap(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max - 1) + "…";
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    record Authorization(URI redirectUri, String browserNonce) {}
    record OAuthState(String browserNonce, long expiresAtMillis) {}
    record DiscordIdentity(String id, String username, String displayName) {}
    record IdentitySession(String sessionId, DiscordIdentity identity, long expiresAtMillis) {}
    record FeedbackRequest(String message, boolean identify, String website, JsonNode context) {}

    static final class IdentityRequiredException extends IllegalArgumentException {
        IdentityRequiredException() { super("Connect Discord before sending identified feedback"); }
    }
}
