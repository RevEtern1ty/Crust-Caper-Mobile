package com.crustcaper.api.payment;

import static com.crustcaper.api.payment.PaymentGateway.PaymentResult.DECLINED;
import static com.crustcaper.api.payment.PaymentGateway.PaymentResult.PAID;
import static com.crustcaper.api.payment.PaymentGateway.PaymentResult.PROCESSING;
import static com.crustcaper.api.payment.PaymentGatewayException.Kind.INVALID_REQUEST;
import static com.crustcaper.api.payment.PaymentGatewayException.Kind.INVALID_RESPONSE;
import static com.crustcaper.api.payment.PaymentGatewayException.Kind.NOT_DISPATCHED;
import static com.crustcaper.api.payment.PaymentGatewayException.Kind.UNAVAILABLE;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.crustcaper.api.payment.PaymentGateway.CheckoutChannel;
import com.crustcaper.api.payment.PaymentGateway.PaymentRequest;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

class FlutterwavePaymentGatewayTest {
    private static final String KEY = "fixture-provider-key";
    private static final String RETURN = "https://example.test/payment-return";
    private static final String PAYMENT_LINK = "https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-fixture";
    private static final String EMAIL = "guest@example.test";
    private static final Instant NOW = Instant.parse("2026-11-25T18:00:00Z");
    private static final Instant EXPIRY = NOW.plusSeconds(300);

    private final ObjectMapper mapper = new ObjectMapper();
    private final AtomicReference<RecordedRequest> recorded = new AtomicReference<>();
    private final AtomicInteger requestCount = new AtomicInteger();
    private HttpServer fixture;
    private PaymentGateway gateway;

    @BeforeEach
    void startFixtureServer() throws IOException {
        fixture = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fixture.start();
        gateway = gatewayWithReadTimeout(1_000);
    }

    @AfterEach
    void stopFixtureServer() {
        if (fixture != null) fixture.stop(0);
    }

    @Test
    void opensHostedCheckoutWithPersistedReferenceAndHoldDeadline() throws IOException {
        fixtureResponse(200, hostedLink(PAYMENT_LINK));

        assertThat(gateway.open(paymentRequest(EMAIL, EXPIRY)).checkoutUrl()).isEqualTo(PAYMENT_LINK);

        RecordedRequest sent = recorded.get();
        assertThat(sent.method()).isEqualTo("POST");
        assertThat(sent.uri()).isEqualTo(URI.create("/v3/payments"));
        assertThat(sent.authorization()).isEqualTo("Bearer " + KEY);
        assertThat(sent.contentType()).isEqualTo("application/json");
        JsonNode json = mapper.readTree(sent.body());
        assertThat(json.path("tx_ref").asString("")).isEqualTo("attempt-1");
        assertThat(json.path("amount").longValue()).isEqualTo(9_200);
        assertThat(json.path("currency").asString("")).isEqualTo("RWF");
        assertThat(json.path("redirect_url").asString("")).isEqualTo(RETURN + "?orderId=order-1");
        assertThat(json.path("payment_options").asString("")).isEqualTo("card, mobilemoneyrwanda");
        assertThat(json.path("link_expiration").asString("")).isEqualTo(EXPIRY.toString());
        assertThat(json.path("customer").path("email").asString("")).isEqualTo(EMAIL);
        assertThat(json.path("customer").path("phone_number").asString("")).isEqualTo("+250700000000");
    }

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
        "card | card",
        "mobilemoneyrwanda | mobilemoneyrwanda",
        "'  card,mobilemoneyrwanda  ' | 'card, mobilemoneyrwanda'",
        "mobilemoneyrwanda, card | mobilemoneyrwanda, card",
    })
    void sendsOnlyConfiguredOptionsToHostedCheckoutOnBothChannels(String options, String expected) throws IOException {
        fixtureResponse(200, hostedLink(PAYMENT_LINK));
        PaymentGateway configured = gatewayWithPaymentOptions(options);
        for (CheckoutChannel channel : CheckoutChannel.values()) {
            var request = new PaymentRequest("attempt-1", "order-1", 9_200, "RWF", "+250700000000",
                    EMAIL, EXPIRY, channel);
            assertThat(configured.open(request).checkoutUrl()).isEqualTo(PAYMENT_LINK);
            assertThat(mapper.readTree(recorded.get().body()).path("payment_options").asString("")).isEqualTo(expected);
        }
        assertThat(requestCount.get()).isEqualTo(CheckoutChannel.values().length);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {
        "", "  ", "card,", ",mobilemoneyrwanda", "card, ,mobilemoneyrwanda", "card, card",
        "mobilemoneyrwanda, mobilemoneyrwanda", "card, mobilemoneyrwanda, card", "CARD", "card, unknown-option",
    })
    void failsStartupForMissingOrInvalidPaymentOptions(String options) {
        var failure = assertThrows(IllegalStateException.class, () -> gatewayWithPaymentOptions(options));
        assertThat(failure).hasMessage("CRUSTCAPER_FLUTTERWAVE_PAYMENT_OPTIONS must list card, mobilemoneyrwanda or both without duplicates");
        assertThat(requestCount.get()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "https://example.test",
        "https://example.test/",
        "https://example.test/callback",
        "https://example.test/checkout/payment-return",
        "https://example.test/payment-return/extra",
        "https://example.test/payment-return/",
        "https://example.test/%70ayment-return",
    })
    void rejectsNoncanonicalPaymentReturnUrlAtStartup(String url) {
        assertThrows(IllegalStateException.class, () -> gatewayWithReturnUrl(url, 1_000));
        assertThat(requestCount.get()).isZero();
    }

    @Test
    void allowsLocalHttpsRehearsalReturnUrl() throws IOException {
        String url = "https://localhost/payment-return";
        fixtureResponse(200, hostedLink(PAYMENT_LINK));

        assertThat(gatewayWithReturnUrl(url, 1_000).open(paymentRequest(EMAIL, EXPIRY)).checkoutUrl())
                .isEqualTo(PAYMENT_LINK);
        assertThat(mapper.readTree(recorded.get().body()).path("redirect_url").asString(""))
                .isEqualTo(url + "?orderId=order-1");
    }

    @Test
    void sendsWebOrdersBackToTheConfiguredStorefrontAndKeepsNativeReturn() throws IOException {
        fixtureResponse(200, hostedLink(PAYMENT_LINK));
        String browserReturn = "https://storefront.example.test/web-payment-return";
        PaymentGateway bothChannels = new FlutterwavePaymentGateway(fixtureOrigin(), URI.create(RETURN),
                URI.create(browserReturn), KEY, mapper, Clock.fixed(NOW, ZoneOffset.UTC), 1_000, 1_000);
        PaymentRequest web = new PaymentRequest("attempt-1", "order-1", 9_200, "RWF", "+250700000000",
                EMAIL, EXPIRY, CheckoutChannel.WEB);

        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.open(web)).kind())
                .isEqualTo(NOT_DISPATCHED);
        assertThat(requestCount.get()).isZero();
        bothChannels.open(web);
        assertThat(mapper.readTree(recorded.get().body()).path("redirect_url").asString())
                .isEqualTo(browserReturn + "?orderId=order-1");
        bothChannels.open(paymentRequest(EMAIL, EXPIRY));
        assertThat(mapper.readTree(recorded.get().body()).path("redirect_url").asString())
                .isEqualTo(RETURN + "?orderId=order-1");
        assertThat(requestCount.get()).isEqualTo(2);
    }

    @Test
    void rejectsMissingEmailAndElapsedHoldBeforeNetworkCall() {
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.open(paymentRequest(null, EXPIRY))).kind())
                .isEqualTo(INVALID_REQUEST);
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.open(paymentRequest(EMAIL, NOW))).kind())
                .isEqualTo(INVALID_REQUEST);
        assertThat(requestCount.get()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "http://checkout.flutterwave.com/v3/hosted/pay/flwlnk-fixture",
        "https://checkout.flutterwave.com.example.test/v3/hosted/pay/flwlnk-fixture",
        "https://someone@checkout.flutterwave.com/v3/hosted/pay/flwlnk-fixture",
        "https://checkout.flutterwave.com:8443/v3/hosted/pay/flwlnk-fixture",
        "https://checkout.flutterwave.com/v3/hosted/pay/%2e%2e",
        "https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-fixture?return_url=example.test",
    })
    void rejectsUnexpectedHostedCheckoutUrl(String link) {
        fixtureResponse(200, hostedLink(link));

        PaymentGatewayException error = assertThrows(PaymentGatewayException.class, () -> gateway.open(paymentRequest(EMAIL, EXPIRY)));
        assertThat(error.kind()).isEqualTo(INVALID_RESPONSE);
        assertThat(error.getMessage()).doesNotContain(link);
    }

    @Test
    void verifiesProviderTransactionByIdBeforeReturningPaymentFacts() {
        fixtureResponse(200, verifiedResponse("12345", "attempt-1", "9200", "RWF", "successful"));

        assertThat(gateway.verify("12345")).isEqualTo(new VerifiedPayment("attempt-1", "12345", 9_200, "RWF", PAID));
        assertThat(recorded.get().uri()).isEqualTo(URI.create("/v3/transactions/12345/verify"));
        assertThat(recorded.get().method()).isEqualTo("GET");
        assertThat(recorded.get().authorization()).isEqualTo("Bearer " + KEY);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"null", "\"9200\"", "0", "9199", "9199.9999999999999999999"})
    void doesNotPublishPaidVerificationWithoutTheFullCharge(String chargedAmount) {
        fixtureResponse(200, verifiedResponse("12345", "attempt-1", "9200", "RWF", "successful", chargedAmount));

        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verify("12345")).kind())
                .isEqualTo(INVALID_RESPONSE);
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verifyByReference("attempt-1")).kind())
                .isEqualTo(INVALID_RESPONSE);
    }

    @Test
    void keepsTheNominalAmountWhenTheActualChargeIncludesFees() {
        fixtureResponse(200, verifiedResponse("12345", "attempt-1", "9200", "RWF", "successful", "9400"));

        assertThat(gateway.verifyByReference("attempt-1"))
                .contains(new VerifiedPayment("attempt-1", "12345", 9_200, "RWF", PAID));
    }

    @Test
    void preservesNonfinalProviderVerificationAndLookupUsesStableReference() {
        fixtureResponse(200, verifiedResponse("12345", "attempt-1", "9200.0", "RWF", "pending"));

        assertThat(gateway.verifyByReference("attempt-1")).contains(new VerifiedPayment("attempt-1", "12345", 9_200, "RWF", PROCESSING));
        assertThat(recorded.get().uri()).isEqualTo(URI.create("/v3/transactions/verify_by_reference?tx_ref=attempt-1"));
    }

    @Test
    void exposesIndividualFailedTransactionWithoutConflatingItWithPending() {
        fixtureResponse(200, verifiedResponse("12345", "attempt-1", "9200", "RWF", "failed"));
        assertThat(gateway.verify("12345").result()).isEqualTo(DECLINED);
    }

    @Test
    void preventsMismatchedVerificationFromReachingSettlement() {
        fixtureResponse(200, verifiedResponse("12346", "other-attempt", "9200", "RWF", "successful"));

        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verify("12345")).kind()).isEqualTo(INVALID_RESPONSE);
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verifyByReference("attempt-1")).kind())
                .isEqualTo(INVALID_RESPONSE);
    }

    @ParameterizedTest
    @ValueSource(strings = { "9200.0000000000000000001", "-100", "\"9200\"", "9223372036854775808" })
    void rejectsAmountsThatAreNotPositiveExactIntegers(String amount) {
        fixtureResponse(200, verifiedResponse("12345", "attempt-1", amount, "RWF", "successful"));
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verify("12345")).kind()).isEqualTo(INVALID_RESPONSE);
    }

    @Test
    void recognizesMissingReferenceWithoutMarkingPaymentDeclined() {
        fixtureResponse(400, "{\"status\":\"error\",\"message\":\"Transaction not found\"}");
        assertThat(gateway.verifyByReference("attempt-1")).isEmpty();
    }

    @Test
    void suppressesProviderBodyAndDoesNotRetryAmbiguousOpen() {
        fixtureResponse(500, "Bearer " + KEY + " customer " + EMAIL);

        PaymentGatewayException error = assertThrows(PaymentGatewayException.class, () -> gateway.open(paymentRequest(EMAIL, EXPIRY)));
        assertThat(error.kind()).isEqualTo(UNAVAILABLE);
        assertThat(error.getMessage()).doesNotContain(KEY, EMAIL);
        assertThat(error.getCause()).isNull();
        assertThat(requestCount.get()).isEqualTo(1);
    }

    @Test
    void distinguishesARefusedHostedConnectionFromAnUncertainResponse() {
        stopFixtureServer();
        fixture = null;

        PaymentGatewayException refused = assertThrows(PaymentGatewayException.class,
                () -> gateway.open(paymentRequest(EMAIL, EXPIRY)));
        assertThat(refused.kind()).isEqualTo(NOT_DISPATCHED);
        assertThat(refused.getCause()).isNull();
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verify("12345")).kind())
                .isEqualTo(UNAVAILABLE);
    }

    @Test
    void keepsALostResponseUncertainAfterTheProviderReceivesTheBody() {
        fixture.createContext("/v3/payments", exchange -> {
            try (exchange) {
                byte[] body = exchange.getRequestBody().readAllBytes();
                recorded.set(new RecordedRequest(exchange.getRequestMethod(), exchange.getRequestURI(),
                        exchange.getRequestHeaders().getFirst("Authorization"), exchange.getRequestHeaders().getFirst("Content-Type"), body));
                requestCount.incrementAndGet();
            }
        });

        PaymentGatewayException lost = assertThrows(PaymentGatewayException.class,
                () -> gateway.open(paymentRequest(EMAIL, EXPIRY)));
        assertThat(lost.kind()).isEqualTo(UNAVAILABLE);
        assertThat(recorded.get().body()).isNotEmpty();
        assertThat(requestCount.get()).isEqualTo(1);
    }

    @Test
    void neverForwardsAuthorizationToRedirectDestination() {
        fixture.createContext("/", exchange -> {
            try (exchange) {
                requestCount.incrementAndGet();
                exchange.getResponseHeaders().set("Location", fixtureOrigin() + "/unexpected");
                exchange.sendResponseHeaders(302, -1);
            }
        });
        assertThat(assertThrows(PaymentGatewayException.class, () -> gateway.verify("12345")).kind()).isEqualTo(UNAVAILABLE);
        assertThat(requestCount.get()).isEqualTo(1);
    }

    @Test
    void abortsWhenProviderDoesNotSendBodyWithinReadTimeout() {
        fixture.createContext("/", exchange -> {
            try (exchange) {
                exchange.sendResponseHeaders(200, 16);
                exchange.getResponseBody().flush();
                try {
                    Thread.sleep(400);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
        });
        PaymentGateway shortRead = gatewayWithReadTimeout(100);
        assertThat(assertThrows(PaymentGatewayException.class, () -> shortRead.verify("12345")).kind()).isEqualTo(UNAVAILABLE);
    }

    @Test
    void webhookSecretValidationIsExactAndNeverFallsBackToEmptySecret() {
        String secret = "0123456789-0123456789-0123456789";
        FlutterwaveWebhookSignature signature = new FlutterwaveWebhookSignature(secret);
        assertThat(signature.matches(secret)).isTrue();
        assertThat(signature.matches(null)).isFalse();
        assertThat(signature.matches(" " + secret)).isFalse();
        assertThat(signature.matches(secret + "x")).isFalse();
        assertThrows(IllegalStateException.class, () -> new FlutterwaveWebhookSignature(""));
    }

    private void fixtureResponse(int status, String body) {
        fixture.createContext("/", exchange -> {
            try (exchange) {
                recorded.set(new RecordedRequest(exchange.getRequestMethod(), exchange.getRequestURI(),
                        exchange.getRequestHeaders().getFirst("Authorization"), exchange.getRequestHeaders().getFirst("Content-Type"),
                        exchange.getRequestBody().readAllBytes()));
                requestCount.incrementAndGet();
                byte[] response = body.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, response.length);
                exchange.getResponseBody().write(response);
            }
        });
    }

    private URI fixtureOrigin() {
        return URI.create("http://127.0.0.1:" + fixture.getAddress().getPort());
    }

    private PaymentGateway gatewayWithReadTimeout(int readTimeoutMs) {
        return gatewayWithReturnUrl(RETURN, readTimeoutMs);
    }

    private PaymentGateway gatewayWithReturnUrl(String returnUrl, int readTimeoutMs) {
        return new FlutterwavePaymentGateway(fixtureOrigin(), URI.create(returnUrl), KEY, mapper,
                Clock.fixed(NOW, ZoneOffset.UTC), 1_000, readTimeoutMs);
    }

    private PaymentGateway gatewayWithPaymentOptions(String options) {
        return new FlutterwavePaymentGateway(fixtureOrigin(), URI.create(RETURN),
                URI.create("https://storefront.example.test/web-payment-return"), KEY, options, mapper,
                Clock.fixed(NOW, ZoneOffset.UTC), 1_000, 1_000);
    }

    private static PaymentRequest paymentRequest(String email, Instant expiresAt) {
        return new PaymentRequest("attempt-1", "order-1", 9_200, "RWF", "+250700000000", email, expiresAt);
    }

    private static String hostedLink(String link) {
        return "{\"status\":\"success\",\"data\":{\"link\":\"" + link + "\"}}";
    }

    private static String verifiedResponse(String id, String reference, String amount, String currency, String status) {
        return verifiedResponse(id, reference, amount, currency, status, "successful".equals(status) ? amount : null);
    }

    private static String verifiedResponse(String id, String reference, String amount, String currency, String status,
                                           String chargedAmount) {
        String chargeField = chargedAmount == null ? "" : ",\"charged_amount\":" + chargedAmount;
        return """
                {"status":"success","data":{"id":%s,"tx_ref":"%s","amount":%s,"currency":"%s","status":"%s"%s}}
                """.formatted(id, reference, amount, currency, status, chargeField);
    }

    private record RecordedRequest(String method, URI uri, String authorization, String contentType, byte[] body) { }
}
