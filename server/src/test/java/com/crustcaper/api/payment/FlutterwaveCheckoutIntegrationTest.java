package com.crustcaper.api.payment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.nullValue;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.ApiModels.CartLine;
import com.crustcaper.api.ApiModels.Localized;
import com.crustcaper.api.ApiModels.OrderInput;
import com.crustcaper.api.ApiModels.Product;
import com.crustcaper.api.ApiModels.QuoteInput;
import com.crustcaper.api.operator.OperatorMfaFixture;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(properties = {
    "crustcaper.payment.provider=flutterwave",
    "crustcaper.payment.reconciliation.enabled=false",
    "spring.datasource.hikari.schema=flutterwave_checkout_test",
    "spring.flyway.schemas=flutterwave_checkout_test"
})
@ActiveProfiles("local")
@AutoConfigureMockMvc
@DirtiesContext
class FlutterwaveCheckoutIntegrationTest {
    @DynamicPropertySource
    static void operatorMfaKey(DynamicPropertyRegistry registry) {
        OperatorMfaFixture.registerKey(registry);
    }

    private static final String API = "/api/v1";
    private static final String STORE_PREFIX = "provider-fixture-";
    private static final String SKU = "fixture-burger";
    private static final String SLOT = "fixture-slot";
    private static final long TOTAL = 9200;
    private static final String KEY = "Idempotency-Key";
    private static final String FIXTURE_KEY = "checkout-wire-fixture";
    private static final String WEBHOOK_SECRET = "webhook-wire-fixture-only";
    private static final String RETRY_LINK = "https://checkout.flutterwave.com/v3/hosted/pay/retry-fixture";
    private static final ObjectMapper WIRE_JSON = JsonMapper.builder().build();

    private static final AtomicReference<JsonNode> OPEN_BODY = new AtomicReference<>();
    private static final AtomicInteger OPENS = new AtomicInteger();
    private static final AtomicInteger VERIFICATIONS = new AtomicInteger();
    private static final AtomicLong CHARGED = new AtomicLong();
    private static final AtomicLong TRANSACTION = new AtomicLong();
    private static final AtomicBoolean TIMEOUT_NEXT_OPEN = new AtomicBoolean();
    private static final AtomicBoolean RETURN_HOSTED_LINK = new AtomicBoolean();
    private static final AtomicReference<Runnable> BEFORE_HOSTED_LINK = new AtomicReference<>();
    private static HttpServer provider;

    private final String store = STORE_PREFIX + UUID.randomUUID();
    private final UUID operator = UUID.randomUUID();
    private UUID guestSession;

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @TestBean(name = "flutterwaveGateway", methodName = "loopbackGateway", enforceOverride = true)
    FlutterwavePaymentGateway gateway;
    @TestBean(name = "flutterwaveWebhookSignature", methodName = "fixtureSignature", enforceOverride = true)
    FlutterwaveWebhookSignature signature;

    static FlutterwavePaymentGateway loopbackGateway() throws IOException {
        provider = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        provider.createContext("/v3/payments", exchange -> {
            try (exchange) {
                if (!authorized(exchange) || !"POST".equals(exchange.getRequestMethod())) {
                    exchange.sendResponseHeaders(401, -1);
                    return;
                }
                OPEN_BODY.set(WIRE_JSON.readTree(exchange.getRequestBody()));
                OPENS.incrementAndGet();
                if (RETURN_HOSTED_LINK.get()) {
                    Runnable beforeLink = BEFORE_HOSTED_LINK.getAndSet(null);
                    if (beforeLink != null) beforeLink.run();
                    byte[] body = WIRE_JSON.writeValueAsBytes(WIRE_JSON.createObjectNode().put("status", "success").set(
                        "data", WIRE_JSON.createObjectNode().put("link", RETRY_LINK)));
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, body.length);
                    exchange.getResponseBody().write(body);
                }
            }
        });
        provider.createContext("/v3/transactions/", FlutterwaveCheckoutIntegrationTest::verify);
        provider.start();
        return new FlutterwavePaymentGateway(URI.create("http://127.0.0.1:" + provider.getAddress().getPort()),
            URI.create("https://localhost/payment-return"), null, FIXTURE_KEY, "card, mobilemoneyrwanda", WIRE_JSON,
            Clock.systemUTC(), 1000, 1000, uri -> {
                if ("/v3/payments".equals(uri.getPath()) && TIMEOUT_NEXT_OPEN.getAndSet(false)) {
                    var connection = mock(HttpURLConnection.class);
                    doThrow(new SocketTimeoutException()).when(connection).connect();
                    when(connection.getOutputStream()).thenAnswer(invocation -> {
                        connection.connect();
                        throw new AssertionError("Connection should have timed out");
                    });
                    return connection;
                }
                return (HttpURLConnection) uri.toURL().openConnection();
            });
    }

    static FlutterwaveWebhookSignature fixtureSignature() {
        return new FlutterwaveWebhookSignature(WEBHOOK_SECRET);
    }

    @BeforeEach
    void resetProviderFixture() {
        OPEN_BODY.set(null);
        OPENS.set(0);
        VERIFICATIONS.set(0);
        CHARGED.set(TOTAL - 1);
        TRANSACTION.set(ThreadLocalRandom.current().nextLong(1_000_000_000_000_000L, Long.MAX_VALUE));
        TIMEOUT_NEXT_OPEN.set(false);
        RETURN_HOSTED_LINK.set(false);
        BEFORE_HOSTED_LINK.set(null);
    }

    @AfterEach
    void removeFixtureRows() {
        jdbc.sql("""
            DELETE FROM payment_exceptions WHERE attempt_id IN (
                SELECT p.id FROM payment_attempts p JOIN orders o ON o.id = p.order_id WHERE o.store_id = ?
            )
            """).param(store).update();
        jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
            .param(store).update();
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        if (guestSession != null) {
            jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guestSession).update();
        }
        jdbc.sql("DELETE FROM operator_sessions WHERE operator_id = ?").param(operator).update();
        jdbc.sql("DELETE FROM operator_accounts WHERE id = ? AND store_id = ?").params(operator, store).update();
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
    }

    @AfterAll
    static void stopProvider() {
        if (provider != null) provider.stop(0);
    }

    private static boolean authorized(HttpExchange exchange) {
        return ("Bearer " + FIXTURE_KEY).equals(exchange.getRequestHeaders().getFirst("Authorization"));
    }

    private static void verify(HttpExchange exchange) throws IOException {
        try (exchange) {
            JsonNode payment = OPEN_BODY.get();
            long transaction = TRANSACTION.get();
            boolean byId = ("/v3/transactions/" + transaction + "/verify").equals(exchange.getRequestURI().getPath());
            boolean byReference = payment != null && "/v3/transactions/verify_by_reference".equals(exchange.getRequestURI().getPath())
                && ("tx_ref=" + payment.path("tx_ref").asString()).equals(exchange.getRequestURI().getRawQuery());
            if (!authorized(exchange) || !"GET".equals(exchange.getRequestMethod()) || payment == null || !(byId || byReference)) {
                exchange.sendResponseHeaders(404, -1);
                return;
            }
            VERIFICATIONS.incrementAndGet();
            byte[] body = WIRE_JSON.writeValueAsBytes(WIRE_JSON.createObjectNode().put("status", "success").set("data",
                WIRE_JSON.createObjectNode().put("id", transaction).put("status", "successful")
                    .put("tx_ref", payment.path("tx_ref").asString()).put("currency", "RWF")
                    .put("amount", TOTAL).put("charged_amount", CHARGED.get())));
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
        }
    }

    @Test
    void lostCheckoutLinkReplaysTheSameAttemptAndOnlyVerifiedFullPaymentReachesKitchen() throws Exception {
        String kitchen = seedStoreAndKitchen();
        FixtureOrder input = createOrder();
        String guest = input.guestToken();
        String order = input.orderId();
        String orderPath = API + "/orders/" + order;
        String paymentPath = orderPath + "/payments";
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest).header(KEY, "wire-payment"))
            .andExpect(status().isServiceUnavailable());
        JsonNode sent = OPEN_BODY.get();
        assertThat(sent).isNotNull();
        String reference = sent.path("tx_ref").asString();
        assertThat(reference).matches("[0-9a-f-]{36}");
        assertThat(sent.path("redirect_url").asString()).endsWith("/payment-return?orderId=" + order);
        assertThat(sent.path("currency").asString()).isEqualTo("RWF");
        assertThat(sent.path("amount").asLong()).isEqualTo(TOTAL);
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest).header(KEY, "wire-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(reference))
            .andExpect(jsonPath("$.checkoutUrl").value(nullValue()));
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest).header(KEY, "unrelated-key"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("payment_pending"));
        assertThat(OPENS.get()).isEqualTo(1);

        String webhook = API + "/webhooks/flutterwave";
        String transaction = Long.toString(TRANSACTION.get());
        String event = "{\"event\":\"charge.completed\",\"data\":{\"id\":" + transaction + "}}";
        api.perform(post(webhook).header("verif-hash", "fixture-wrong").contentType(MediaType.APPLICATION_JSON).content(event))
            .andExpect(status().isUnauthorized());
        assertThat(VERIFICATIONS.get()).isZero();
        api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("processing"))
            .andExpect(jsonPath("$.pickupCode").value(nullValue()));
        api.perform(post(webhook).header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON).content(event))
            .andExpect(status().isServiceUnavailable());
        api.perform(get(API + "/operator/orders").header(HttpHeaders.AUTHORIZATION, "Bearer " + kitchen))
            .andExpect(status().isOk()).andExpect(jsonPath("$.orders").isEmpty());
        assertThat(VERIFICATIONS.get()).isEqualTo(2);
        UUID attemptId = UUID.fromString(reference);
        assertThat(verificationTime(attemptId)).isNull();

        CHARGED.set(TOTAL + 25);
        api.perform(post(webhook).header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON).content(event))
            .andExpect(status().isOk());
        OffsetDateTime verifiedAt = verificationTime(attemptId);
        assertThat(verifiedAt).isNotNull();
        String pickupCode = json.readTree(api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("paid"))
            .andReturn().getResponse().getContentAsByteArray()).path("pickupCode").asString();
        assertThat(pickupCode).matches("[0-9]{6}");
        api.perform(post(webhook).header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON).content(event))
            .andExpect(status().isOk());
        assertThat(verificationTime(attemptId)).isEqualTo(verifiedAt);
        api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest))
            .andExpect(status().isOk()).andExpect(jsonPath("$.pickupCode").value(pickupCode));
        api.perform(get(API + "/operator/orders").header(HttpHeaders.AUTHORIZATION, "Bearer " + kitchen))
            .andExpect(status().isOk()).andExpect(jsonPath("$.orders.length()").value(1))
            .andExpect(jsonPath("$.orders[0].id").value(order));
        assertThat(jdbc.sql("SELECT provider_transaction_id FROM payment_attempts WHERE order_id = ? AND status = 'paid'")
            .param(UUID.fromString(order)).query(String.class).list()).containsExactly(transaction);
        assertThat(jdbc.sql("SELECT count(*) FROM payment_attempts WHERE order_id = ?")
            .param(UUID.fromString(order)).query(Integer.class).single()).isEqualTo(1);
        assertThat(OPENS.get()).isEqualTo(1);
    }

    @Test
    void aConnectTimeoutAllowsOneNewPaymentForTheSameReservedOrder() throws Exception {
        seedStoreAndKitchen();
        FixtureOrder input = createOrder();
        String authorization = "Bearer " + input.guestToken();
        String orderPath = API + "/orders/" + input.orderId();
        String paymentPath = orderPath + "/payments";
        UUID orderId = UUID.fromString(input.orderId());
        TIMEOUT_NEXT_OPEN.set(true);
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "timed-out-connect"))
            .andExpect(status().isServiceUnavailable());
        assertThat(OPENS.get()).isZero();
        UUID declined = jdbc.sql("""
            SELECT id FROM payment_attempts WHERE order_id = ? AND status = 'declined'
                AND checkout_url IS NULL AND provider_transaction_id IS NULL
            """).param(orderId).query(UUID.class).optional().orElse(null);
        assertThat(declined).isNotNull();
        assertThat(jdbc.sql("""
            SELECT count(*) FROM orders WHERE id = ? AND status = 'awaiting_payment'
                AND payment_status = 'declined' AND reservation_expires_at > now()
            """).param(orderId).query(Long.class).single()).isEqualTo(1);
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "timed-out-connect"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(declined.toString()))
            .andExpect(jsonPath("$.status").value("declined")).andExpect(jsonPath("$.checkoutUrl").value(nullValue()));
        assertThat(OPENS.get()).isZero();

        RETURN_HOSTED_LINK.set(true);
        String retryKey = "explicit-payment-retry";
        JsonNode retried = json.readTree(api.perform(post(paymentPath)
            .header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, retryKey))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkoutUrl").value(RETRY_LINK))
            .andReturn().getResponse().getContentAsByteArray());
        String reference = retried.path("id").asString();
        assertThat(reference).isNotEqualTo(declined.toString());
        assertThat(OPEN_BODY.get().path("tx_ref").asString()).isEqualTo(reference);
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, retryKey))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(reference));
        CHARGED.set(TOTAL);
        long transaction = TRANSACTION.get();
        api.perform(post(API + "/webhooks/flutterwave").header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON)
            .content("{\"event\":\"charge.completed\",\"data\":{\"id\":" + transaction + "}}")).andExpect(status().isOk());
        api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, authorization))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("paid"))
            .andExpect(jsonPath("$.status").value("accepted"));
        assertThat(jdbc.sql("SELECT status FROM payment_attempts WHERE order_id = ? ORDER BY sequence")
            .param(orderId).query(String.class).list()).containsExactly("declined", "paid");
        assertThat(OPENS.get()).isEqualTo(1);
    }

    @Test
    void expiredHoldDoesNotExposeTheHostedLinkButStillReconcilesTheOriginalAttempt() throws Exception {
        String kitchen = seedStoreAndKitchen();
        FixtureOrder input = createOrder();
        String authorization = "Bearer " + input.guestToken();
        String orderPath = API + "/orders/" + input.orderId();
        String paymentPath = orderPath + "/payments";
        RETURN_HOSTED_LINK.set(true);
        String attemptId = json.readTree(api.perform(post(paymentPath)
                .header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "expiry-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkoutUrl").value(RETRY_LINK))
            .andReturn().getResponse().getContentAsByteArray()).path("id").asString();
        api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, authorization))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(RETRY_LINK));
        expireHold(input);

        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "expiry-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(attemptId))
            .andExpect(jsonPath("$.status").value("processing")).andExpect(jsonPath("$.checkoutUrl").value(nullValue()));
        api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, authorization))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"))
            .andExpect(jsonPath("$.paymentAttempt.id").value(attemptId))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(nullValue()));
        api.perform(get(API + "/orders/recovery").header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "wire-order"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentAttempt.id").value(attemptId))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(nullValue()));
        api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "wire-order")
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(orderInput(input.quoteId()))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentAttempt.id").value(attemptId))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(nullValue()));
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "new-expired-payment"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("reservation_expired"));
        assertThat(OPENS.get()).isEqualTo(1);

        // The expired order no longer consumes the one-place slot.
        FixtureOrder replacement = placeOrder(input.guestToken(), "replacement-order");
        assertThat(replacement.orderId()).isNotEqualTo(input.orderId());

        CHARGED.set(TOTAL);
        String transaction = Long.toString(TRANSACTION.get());
        api.perform(post(API + "/webhooks/flutterwave").header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON)
            .content("{\"event\":\"charge.completed\",\"data\":{\"id\":" + transaction + "}}"))
            .andExpect(status().isOk());
        api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, authorization))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"))
            .andExpect(jsonPath("$.paymentStatus").value("refund_pending"))
            .andExpect(jsonPath("$.paymentAttempt.id").value(attemptId))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(nullValue()));
        api.perform(get(API + "/operator/orders").header(HttpHeaders.AUTHORIZATION, "Bearer " + kitchen))
            .andExpect(status().isOk()).andExpect(jsonPath("$.orders").isEmpty());
        assertThat(jdbc.sql("""
            SELECT reason FROM payment_exceptions WHERE attempt_id = ? AND provider_transaction_id = ?
            """).params(UUID.fromString(attemptId), transaction).query(String.class).list())
            .containsExactly("unavailable_reservation");
    }

    @Test
    void providerLinkArrivingAfterExpiryKeepsTheAttemptWithoutExposingTheLink() throws Exception {
        seedStoreAndKitchen();
        FixtureOrder input = createOrder();
        String authorization = "Bearer " + input.guestToken();
        String paymentPath = API + "/orders/" + input.orderId() + "/payments";
        RETURN_HOSTED_LINK.set(true);
        BEFORE_HOSTED_LINK.set(() -> expireHold(input));

        String reference = json.readTree(api.perform(post(paymentPath)
                .header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "late-checkout-link"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("processing"))
            .andExpect(jsonPath("$.checkoutUrl").value(nullValue()))
            .andReturn().getResponse().getContentAsByteArray()).path("id").asString();
        assertThat(OPEN_BODY.get().path("tx_ref").asString()).isEqualTo(reference);
        api.perform(post(paymentPath).header(HttpHeaders.AUTHORIZATION, authorization).header(KEY, "late-checkout-link"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(reference))
            .andExpect(jsonPath("$.checkoutUrl").value(nullValue()));
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE order_id = ? AND status = 'processing'")
            .param(UUID.fromString(input.orderId())).query(UUID.class).list()).containsExactly(UUID.fromString(reference));
        assertThat(OPENS.get()).isEqualTo(1);
    }

    private void expireHold(FixtureOrder input) {
        assertThat(jdbc.sql("UPDATE orders SET reservation_expires_at = clock_timestamp() - interval '1 second' WHERE id = ?")
            .param(UUID.fromString(input.orderId())).update()).isEqualTo(1);
    }

    private FixtureOrder createOrder() throws Exception {
        JsonNode session = json.readTree(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk())
            .andReturn().getResponse().getContentAsByteArray());
        guestSession = UUID.fromString(session.path("sessionId").asString());
        return placeOrder(session.path("accessToken").asString(), "wire-order");
    }

    private FixtureOrder placeOrder(String guest, String key) throws Exception {
        var quoteInput = new QuoteInput(store, SLOT, List.of(new CartLine(SKU, List.of(), 1, TOTAL)));
        String quote = json.readTree(api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, "Bearer " + guest)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(quoteInput)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(TOTAL))
            .andReturn().getResponse().getContentAsByteArray()).path("quoteId").asString();
        String order = json.readTree(api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, "Bearer " + guest)
            .header(KEY, key).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(orderInput(quote))))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray()).path("id").asString();
        return new FixtureOrder(guest, order, quote);
    }

    private static OrderInput orderInput(String quote) {
        return new OrderInput(quote, "+250700000000", "payment-wire@example.test");
    }

    private record FixtureOrder(String guestToken, String orderId, String quoteId) {}

    private OffsetDateTime verificationTime(UUID attemptId) {
        return jdbc.sql("SELECT verified_at FROM payment_attempts WHERE id = ?")
            .param(attemptId).query((row, index) -> row.getObject("verified_at", OffsetDateTime.class))
            .list().getFirst();
    }

    private String seedStoreAndKitchen() throws Exception {
        String text = json.writeValueAsString(new Localized("Provider fixture", "Provider fixture"));
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            VALUES (?, ?::jsonb, ?::jsonb, ?::jsonb, true, 0, 'fixture')
            """).params(store, text, text, text).update();
        var product = new Product(SKU, new Localized("Fixture burger", "Fixture burger"), null, List.of(), List.of(),
            "burgers", TOTAL, true, List.of(), null);
        jdbc.sql("INSERT INTO menu_products (store_id, sku, position, product) VALUES (?, ?, 1, ?::jsonb)")
            .params(store, SKU, json.writeValueAsString(product)).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '20 minutes', now() + interval '30 minutes', 1)
            """).params(store, SLOT).update();
        String token = "x" + UUID.randomUUID().toString().replace("-", "") + "testAbCdEf";
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(token.getBytes(StandardCharsets.US_ASCII)));
        jdbc.sql("""
            INSERT INTO operator_accounts (id, store_id, username, role, password_hash, mfa_encrypted_secret)
            VALUES (?, ?, ?, 'kitchen', 'fixture', ?)
            """).params(operator, store, store, OperatorMfaFixture.encryptedSeed(operator)).update();
        jdbc.sql("""
            INSERT INTO operator_sessions (token_hash, operator_id, expires_at, mfa_verified)
            VALUES (?, ?, now() + interval '15 minutes', true)
            """)
            .params(hash, operator).update();
        return token;
    }
}
