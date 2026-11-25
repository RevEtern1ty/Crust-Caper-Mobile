package com.crustcaper.api.recovery;

import static com.crustcaper.api.recovery.PhoneVerificationException.Kind.RETRY_LATER;
import static com.crustcaper.api.recovery.PhoneVerificationException.Kind.UNAVAILABLE;
import static com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck.APPROVED;
import static com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck.EXPIRED;
import static com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck.INVALID;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeout;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectMapper;

class TwilioPhoneVerificationGatewayTest {
    private static final String SERVICE_SID = "VA" + "1".repeat(32);
    private static final String KEY_SID = "SK" + "2".repeat(32);
    private static final String KEY_SECRET = "fixture-only-not-a-twilio-credential";
    private static final String VERIFICATION_SID = "VE" + "3".repeat(32);
    private static final String PHONE = "+250700000000";
    private static final String CODE = "012345";
    private static final String SERVICE_PATH = "/v2/Services/" + SERVICE_SID;

    private final AtomicReference<Request> request = new AtomicReference<>();
    private final AtomicReference<Response> response = new AtomicReference<>();
    private final AtomicInteger requests = new AtomicInteger();
    private HttpServer fixture;
    private URI origin;
    private TwilioPhoneVerificationGateway gateway;

    @BeforeEach
    void startFixture() throws IOException {
        fixture = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        origin = URI.create("http://127.0.0.1:" + fixture.getAddress().getPort());
        fixture.createContext("/", this::serve);
        fixture.start();
        gateway = gateway(Duration.ofSeconds(3));
    }

    @AfterEach
    void stopFixture() {
        gateway.close();
        fixture.stop(0);
    }

    @Test
    void sendsOnlyTheNormalizedPhoneAndSmsChannelToTheConfiguredService() {
        respond(201, verification("pending"));

        assertThat(gateway.send(PHONE)).isEqualTo(VERIFICATION_SID);

        Request sent = request.get();
        assertThat(sent.path()).isEqualTo(SERVICE_PATH + "/Verifications");
        assertThat(sent.method()).isEqualTo("POST");
        assertThat(sent.contentType()).isEqualTo("application/x-www-form-urlencoded");
        String expected = KEY_SID + ':' + KEY_SECRET;
        assertThat(sent.authorization()).isEqualTo("Basic " + Base64.getEncoder().encodeToString(expected.getBytes(StandardCharsets.US_ASCII)));
        assertThat(sent.body()).isEqualTo("To=%2B250700000000&Channel=sms");
    }

    @Test
    void checksByStoredSidAndPreservesLeadingZeroInCode() {
        respond(200, verification("approved"));

        assertThat(gateway.check(VERIFICATION_SID, CODE)).isEqualTo(APPROVED);

        Request sent = request.get();
        assertThat(sent.path()).isEqualTo(SERVICE_PATH + "/VerificationCheck");
        assertThat(sent.method()).isEqualTo("POST");
        assertThat(sent.body()).isEqualTo("VerificationSid=" + VERIFICATION_SID + "&Code=" + CODE);
    }

    @Test
    void rejectsInvalidInputsWithoutCallingTheProvider() {
        assertFailure(UNAVAILABLE, () -> gateway.send("250700000000"));
        assertThat(gateway.check(SERVICE_SID, CODE)).isEqualTo(EXPIRED);
        assertThat(gateway.check(VERIFICATION_SID, "12345&key=value")).isEqualTo(INVALID);
        assertThat(requests.get()).isZero();
    }

    @Test
    void failsClosedOnApprovalForAnotherVerificationServiceOrChannel() {
        for (String altered : new String[] {
            verification("approved").replace(VERIFICATION_SID, "VE" + "4".repeat(32)),
            verification("approved").replace(SERVICE_SID, "VA" + "4".repeat(32)),
            verification("approved").replace("sms", "voice"),
            verification("approved").replace("approved", "future-status")
        }) {
            respond(200, altered);
            assertFailure(UNAVAILABLE, () -> gateway.check(VERIFICATION_SID, CODE));
        }
    }

    @Test
    void rejectsAStartedVerificationForAnotherPhoneOrAnAlreadyApprovedStatus() {
        respond(201, verification("pending").replace(PHONE, "+250700000001"));
        assertFailure(UNAVAILABLE, () -> gateway.send(PHONE));
        respond(201, verification("approved"));
        assertFailure(UNAVAILABLE, () -> gateway.send(PHONE));
    }

    @Test
    void pendingCodeIsInvalidAndAnAbsentOrExhaustedVerificationHasExpired() {
        respond(200, verification("pending"));
        assertThat(gateway.check(VERIFICATION_SID, CODE)).isEqualTo(INVALID);
        respond(200, verification("expired"));
        assertThat(gateway.check(VERIFICATION_SID, CODE)).isEqualTo(EXPIRED);
        respond(404, "{}");
        assertThat(gateway.check(VERIFICATION_SID, CODE)).isEqualTo(EXPIRED);
        respond(429, "{\"code\":60202}");
        assertThat(gateway.check(VERIFICATION_SID, CODE)).isEqualTo(EXPIRED);
    }

    @Test
    void distinguishesGenericProviderThrottlingFromUnknownResultsWithoutRetry() {
        respond(429, "{\"code\":20429,\"message\":\"" + PHONE + "\"}");
        assertFailure(RETRY_LATER, () -> gateway.send(PHONE));
        assertFailure(RETRY_LATER, () -> gateway.check(VERIFICATION_SID, CODE));
        respond(503, "{\"message\":\"" + CODE + "\"}");
        assertFailure(UNAVAILABLE, () -> gateway.check(VERIFICATION_SID, CODE));
        assertThat(requests.get()).isEqualTo(3);
    }

    @ParameterizedTest
    @ValueSource(ints = {301, 302, 307, 308})
    void doesNotForwardCredentialsOrCodeToRedirects(int status) {
        response.set(new Response(status, "", origin.resolve("/redirect-target").toString(), null));

        assertFailure(UNAVAILABLE, () -> gateway.check(VERIFICATION_SID, CODE));
        assertThat(requests.get()).isEqualTo(1);
        assertThat(request.get().path()).isEqualTo(SERVICE_PATH + "/VerificationCheck");
    }

    @Test
    void rejectsOversizedAndMalformedProviderResponsesWithoutLeakingPayload() {
        respond(200, "x".repeat(70_000));
        assertFailure(UNAVAILABLE, () -> gateway.check(VERIFICATION_SID, CODE));
        respond(200, verification("approved") + PHONE);
        assertFailure(UNAVAILABLE, () -> gateway.check(VERIFICATION_SID, CODE));
        respond(200, verification("pending").replace("\"status\":", "\"status\":\"approved\",\"status\":"));
        assertFailure(UNAVAILABLE, () -> gateway.check(VERIFICATION_SID, CODE));
    }

    @Test
    void appliesTheDeadlineAfterResponseHeadersAndDoesNotRepeatThePost() {
        CountDownLatch releaseBody = new CountDownLatch(1);
        response.set(new Response(200, verification("approved"), null, releaseBody));
        try (TwilioPhoneVerificationGateway shortDeadline = gateway(Duration.ofSeconds(1))) {
            assertTimeout(Duration.ofSeconds(3), () -> assertFailure(UNAVAILABLE, () -> shortDeadline.check(VERIFICATION_SID, CODE)));
            assertThat(requests.get()).isEqualTo(1);
        } finally {
            releaseBody.countDown();
        }
    }

    private TwilioPhoneVerificationGateway gateway(Duration deadline) {
        return new TwilioPhoneVerificationGateway(origin, deadline, new ObjectMapper(), SERVICE_SID, KEY_SID, KEY_SECRET);
    }

    private void respond(int status, String body) {
        response.set(new Response(status, body, null, null));
    }

    private void serve(HttpExchange exchange) throws IOException {
        try (exchange) {
            byte[] body = exchange.getRequestBody().readAllBytes();
            request.set(new Request(exchange.getRequestMethod(), exchange.getRequestURI().toString(),
                    exchange.getRequestHeaders().getFirst("Authorization"),
                    exchange.getRequestHeaders().getFirst("Content-Type"), new String(body, StandardCharsets.UTF_8)));
            requests.incrementAndGet();
            Response reply = response.get();
            if (reply.location() != null) {
                exchange.getResponseHeaders().set("Location", reply.location());
            }
            byte[] replyBytes = reply.body().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(reply.status(), replyBytes.length);
            if (reply.releaseBody() != null) {
                waitBeforeWritingBody(reply.releaseBody());
            }
            exchange.getResponseBody().write(replyBytes);
        }
    }

    private static void waitBeforeWritingBody(CountDownLatch release) throws IOException {
        try {
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IOException("Fixture body release timed out");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Fixture interrupted");
        }
    }

    private static String verification(String status) {
        return """
                {"sid":"%s","service_sid":"%s","to":"%s","channel":"sms","status":"%s","valid":false}
                """.formatted(VERIFICATION_SID, SERVICE_SID, PHONE, status);
    }

    private static void assertFailure(PhoneVerificationException.Kind kind, Runnable request) {
        PhoneVerificationException error = assertThrows(PhoneVerificationException.class, request::run);
        assertThat(error.kind()).isEqualTo(kind);
        assertThat(error).hasMessage("Phone verification transport failed").hasNoCause();
    }

    private record Request(String method, String path, String authorization, String contentType, String body) { }

    private record Response(int status, String body, String location, CountDownLatch releaseBody) { }
}
