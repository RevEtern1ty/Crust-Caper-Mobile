package com.crustcaper.api.push;

import static com.crustcaper.api.push.ExpoPushTransport.ReceiptStatus.HANDED_OFF;
import static com.crustcaper.api.push.ExpoPushTransport.ReceiptStatus.PENDING;
import static com.crustcaper.api.push.ExpoPushTransport.ReceiptStatus.UNAVAILABLE;
import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.ACCEPTED;
import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.AMBIGUOUS;
import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.INVALID_TOKEN;
import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.REJECTED;
import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.THROTTLED;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeout;

import com.crustcaper.api.push.ExpoPushTransport.ReadyAlert;
import com.crustcaper.api.push.ExpoPushTransport.ReceiptStatus;
import com.crustcaper.api.push.ExpoPushTransport.SendResult;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class ExpoPushHttpTransportTest {
    private static final String TOKEN = "ExpoPushToken[fixture]";
    private static final String KEY = "fixture-only-not-an-expo-access-token";
    private static final String TICKET = "12345678-1234-4abc-9234-1234567890ab";
    private static final String OTHER_TICKET = "12345678-1234-4abc-9234-1234567890ac";
    private static final String SEND = "/--/api/v2/push/send";
    private static final String RECEIPTS = "/--/api/v2/push/getReceipts";
    private static final UUID ORDER = UUID.fromString("01234567-89ab-4cde-8234-123456789abc");
    private static final Instant EXPIRY = Instant.parse("2099-01-01T00:00:00Z");

    private final ObjectMapper json = new ObjectMapper();
    private final List<Request> requests = new CopyOnWriteArrayList<>();
    private volatile Reply response;
    private HttpServer fixture;
    private URI origin;
    private ExpoPushHttpTransport transport;

    @BeforeEach
    void startFixture() throws IOException {
        fixture = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fixture.createContext("/", this::respond);
        fixture.start();
        origin = URI.create("http://127.0.0.1:" + fixture.getAddress().getPort());
        transport = new ExpoPushHttpTransport(origin, Duration.ofSeconds(3), json, KEY);
    }

    @AfterEach
    void stopFixture() {
        transport.close();
        fixture.stop(0);
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "rw"})
    void sendsAWhitelistedLocalizedPayloadAndChecksTheAcceptedTicket(String locale) {
        reply(200, accepted());

        assertThat(transport.send(new ReadyAlert(TOKEN, ORDER, locale, EXPIRY))).isEqualTo(new SendResult(ACCEPTED, TICKET));
        Request request = requests.getFirst();
        assertThat(request.method()).isEqualTo("POST");
        assertThat(request.path()).isEqualTo(SEND);
        assertThat(request.auth()).isEqualTo("Bearer " + KEY);
        assertThat(request.contentType()).isEqualTo("application/json");
        JsonNode message = json.readTree(request.body()).get(0);
        assertThat(message.propertyNames()).containsExactlyInAnyOrder("to", "title", "body", "channelId", "expiration", "data");
        assertThat(message.path("to").stringValue()).isEqualTo(TOKEN);
        assertThat(message.path("title").stringValue()).isEqualTo(locale.equals("rw") ? "Komande yawe iriteguye" : "Your order is ready");
        assertThat(message.path("body").stringValue()).doesNotContain(ORDER.toString(), TOKEN);
        assertThat(message.path("channelId").stringValue()).isEqualTo("pickup-ready");
        assertThat(message.path("expiration").asLong()).isEqualTo(EXPIRY.getEpochSecond());
        assertThat(message.path("data")).isEqualTo(json.readTree("""
                {"type":"pickup-ready","orderId":"%s"}
                """.formatted(ORDER)));
    }

    @Test
    void rejectsInvalidDestinationWithoutAProviderRequest() {
        assertThat(transport.send(new ReadyAlert("garbled-device", ORDER, "en", EXPIRY)).status()).isEqualTo(INVALID_TOKEN);
        assertThat(requests).isEmpty();
    }

    @Test
    void differentiatesExplicitRejectionsFromAmbiguousResponses() {
        reply(429, "{\"errors\":[{\"code\":\"TOO_MANY_REQUESTS\"}]}");
        assertThat(send().status()).isEqualTo(THROTTLED);
        reply(429, "{}");
        assertThat(send().status()).isEqualTo(AMBIGUOUS);
        reply(503, "{\"errors\":[{\"code\":\"TOO_MANY_REQUESTS\"}]}");
        assertThat(send().status()).isEqualTo(AMBIGUOUS);
        reply(400, "{\"errors\":[{\"code\":\"PUSH_TOO_MANY_NOTIFICATIONS\"}]}");
        assertThat(send().status()).isEqualTo(REJECTED);
        reply(200, ticketError("DeviceNotRegistered"));
        assertThat(send().status()).isEqualTo(INVALID_TOKEN);
        reply(200, ticketError("MessageRateExceeded"));
        assertThat(send().status()).isEqualTo(THROTTLED);
        reply(200, ticketError("MessageTooBig"));
        assertThat(send().status()).isEqualTo(REJECTED);
        assertThat(requests).hasSize(7);
    }

    @Test
    void doesNotAcceptContradictoryMalformedOrRepeatedTickets() {
        for (String body : List.of("{}", "{\"data\":[{\"status\":\"ok\",\"id\":\"invalid\"}]}",
                accepted().replace("\"data\":", "\"errors\":[{\"code\":\"UNAUTHORIZED\"}],\"absent\":"),
                accepted().replace("\"data\":", "\"errors\":[{\"code\":\"UNAUTHORIZED\"}],\"data\":"),
                accepted().replace("\"id\":", "\"id\":\"different\",\"id\":"),
                accepted().replace("]}", ",{}]}"), accepted() + "{}", "x".repeat(40_000))) {
            reply(200, body);
            assertThat(send().status()).isEqualTo(AMBIGUOUS);
        }
    }

    @Test
    void neverFollowsRedirectsWithCredentialsOrPushToken() {
        response = new Reply(307, "{}", origin.resolve("/redirect-target").toString(), null);
        assertThat(send().status()).isEqualTo(AMBIGUOUS);
        assertThat(requests).extracting(Request::path).containsExactly(SEND);
    }

    @Test
    void verifiesOnlyTheRequestedReceiptAndRejectsContradictions() {
        reply(200, "{\"data\":{}}");
        assertThat(transport.receipt(TICKET)).isEqualTo(PENDING);
        reply(200, receipt(OTHER_TICKET, "{\"status\":\"ok\"}"));
        assertThat(transport.receipt(TICKET)).isEqualTo(UNAVAILABLE);
        reply(200, receipt(TICKET, "{\"status\":\"ok\"}"));
        assertThat(transport.receipt(TICKET)).isEqualTo(HANDED_OFF);
        reply(200, receipt(TICKET, "{\"status\":\"error\",\"details\":{\"error\":\"DeviceNotRegistered\"}}"));
        assertThat(transport.receipt(TICKET)).isEqualTo(ReceiptStatus.INVALID_TOKEN);
        reply(200, receipt(TICKET, "{\"status\":\"ok\",\"details\":{\"error\":\"DeviceNotRegistered\"}}"));
        assertThat(transport.receipt(TICKET)).isEqualTo(UNAVAILABLE);
        assertThat(requests).allSatisfy(request -> {
            assertThat(request.path()).isEqualTo(RECEIPTS);
            assertThat(request.body()).isEqualTo("{\"ids\":[\"" + TICKET + "\"]}");
            assertThat(request.auth()).isEqualTo("Bearer " + KEY);
        });
    }

    @Test
    void aResponseBodyThatStallsDoesNotCauseAnotherSend() {
        CountDownLatch release = new CountDownLatch(1);
        response = new Reply(200, accepted(), null, release);
        try (var shortDeadline = new ExpoPushHttpTransport(origin, Duration.ofSeconds(1), json, KEY)) {
            assertTimeout(Duration.ofSeconds(3), () -> assertThat(shortDeadline.send(new ReadyAlert(TOKEN, ORDER, "en", EXPIRY)).status())
                    .isEqualTo(AMBIGUOUS));
            assertThat(requests).hasSize(1);
        } finally {
            release.countDown();
        }
    }

    private SendResult send() {
        return transport.send(new ReadyAlert(TOKEN, ORDER, "en", EXPIRY));
    }

    private void reply(int status, String body) {
        response = new Reply(status, body, null, null);
    }

    private void respond(HttpExchange exchange) throws IOException {
        try (exchange) {
            requests.add(new Request(exchange.getRequestMethod(), exchange.getRequestURI().toString(),
                    exchange.getRequestHeaders().getFirst("Authorization"), exchange.getRequestHeaders().getFirst("Content-Type"),
                    new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            Reply reply = response;
            if (reply.location() != null) exchange.getResponseHeaders().add("Location", reply.location());
            byte[] body = reply.body().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(reply.status(), body.length);
            if (reply.release() != null && !bodyAvailable(reply.release())) return;
            exchange.getResponseBody().write(body);
        }
    }

    private static boolean bodyAvailable(CountDownLatch release) {
        try {
            return release.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static String accepted() {
        return "{\"data\":[{\"status\":\"ok\",\"id\":\"" + TICKET + "\"}]}";
    }

    private static String ticketError(String code) {
        return "{\"data\":[{\"status\":\"error\",\"details\":{\"error\":\"" + code + "\"}}]}";
    }

    private static String receipt(String id, String outcome) {
        return "{\"data\":{\"" + id + "\":" + outcome + "}}";
    }

    private record Request(String method, String path, String auth, String contentType, String body) { }
    private record Reply(int status, String body, String location, CountDownLatch release) { }
}
