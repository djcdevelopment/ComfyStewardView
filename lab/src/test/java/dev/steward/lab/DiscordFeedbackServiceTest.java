package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class DiscordFeedbackServiceTest {
    private HttpServer server;
    private URI base;
    private final ObjectMapper mapper = new ObjectMapper();
    private final AtomicReference<String> webhookBody = new AtomicReference<>();

    @BeforeEach void startServer() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        base = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/");
        server.createContext("/token", exchange -> json(exchange, 200, "{\"access_token\":\"test-token\"}"));
        server.createContext("/me", exchange -> {
            assertEquals("Bearer test-token", exchange.getRequestHeaders().getFirst("Authorization"));
            json(exchange, 200, "{\"id\":\"1234567890\",\"username\":\"derek\",\"global_name\":\"Derek\"}");
        });
        server.createContext("/webhook", exchange -> {
            webhookBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            json(exchange, 200, "{\"id\":\"feedback-message\"}");
        });
        server.start();
    }

    @AfterEach void stopServer() {
        server.stop(0);
    }

    @Test void verifiesDiscordIdentityAndRestrictsMentions() throws Exception {
        DiscordFeedbackService service = service();
        DiscordFeedbackService.Authorization authorization = service.beginAuthorization();
        String state = queryValue(authorization.redirectUri(), "state");
        DiscordFeedbackService.IdentitySession session = service.completeAuthorization(
            "code", state, authorization.browserNonce());

        assertEquals("Derek", session.identity().displayName());
        assertThrows(IllegalArgumentException.class, () -> service.completeAuthorization(
            "code", state, authorization.browserNonce()), "OAuth state must be single use");

        ObjectNode context = mapper.createObjectNode();
        context.put("world", "Comfy Era 17 · snapshot #107");
        context.put("view", "Build density · 64 m cells");
        context.put("selection", "X 1 → 2 · Z 3 → 4");
        context.put("release", "abc123");
        String receipt = service.submit(new DiscordFeedbackService.FeedbackRequest(
            "The inspect flow feels excellent", true, "", context), session.identity());

        assertEquals(8, receipt.length());
        JsonNode payload = mapper.readTree(webhookBody.get());
        assertEquals("<@9988776655>", payload.path("content").asText());
        assertEquals(0, payload.path("allowed_mentions").path("parse").size());
        assertEquals("9988776655", payload.path("allowed_mentions").path("users").get(0).asText());
        assertTrue(payload.path("embeds").get(0).toString().contains("1234567890"));
    }

    @Test void anonymousFeedbackDoesNotRequireAnIdentity() throws Exception {
        DiscordFeedbackService service = service();
        service.submit(new DiscordFeedbackService.FeedbackRequest(
            "Anonymous note", false, "", mapper.createObjectNode()), null);
        assertTrue(webhookBody.get().contains("Anonymous"));
    }

    @Test void identifiedFeedbackFailsWithoutVerifiedSession() {
        DiscordFeedbackService service = service();
        assertThrows(DiscordFeedbackService.IdentityRequiredException.class, () ->
            service.submit(new DiscordFeedbackService.FeedbackRequest(
                "Who am I?", true, "", mapper.createObjectNode()), null));
    }

    private DiscordFeedbackService service() {
        FeedbackConfig config = new FeedbackConfig("http://localhost/world/", "client", "secret",
            base.resolve("webhook").toString(), "9988776655");
        return new DiscordFeedbackService(config, mapper,
            HttpClient.newBuilder().build(), base.resolve("authorize"), base.resolve("token"), base.resolve("me"));
    }

    private static String queryValue(URI uri, String name) {
        for (String pair : uri.getRawQuery().split("&")) {
            String[] parts = pair.split("=", 2);
            if (URLDecoder.decode(parts[0], StandardCharsets.UTF_8).equals(name)) {
                return URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
            }
        }
        throw new AssertionError("Missing query parameter " + name);
    }

    private static void json(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
