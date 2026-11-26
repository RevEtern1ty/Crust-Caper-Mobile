package com.crustcaper.api.payment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.ApiModels.CartLine;
import com.crustcaper.api.ApiModels.Localized;
import com.crustcaper.api.ApiModels.OrderInput;
import com.crustcaper.api.ApiModels.Product;
import com.crustcaper.api.ApiModels.QuoteInput;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
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
    private static final String API = "/api/v1";
    private static final String STORE_PREFIX = "provider-fixture-";
    private static final String SKU = "fixture-burger";
    private static final String SLOT = "fixture-slot";
    private static final long TOTAL = 9200;
    private static final String KEY = "Idempotency-Key";
    private static final String FIXTURE_KEY = "checkout-wire-fixture";
    private static final String WEBHOOK_SECRET = "webhook-wire-fixture-only";
    private static final ObjectMapper WIRE_JSON = JsonMapper.builder().build();

    private static final AtomicReference<JsonNode> OPEN_BODY = new AtomicReference<>();
    private static final AtomicInteger OPENS = new AtomicInteger();
    private static final AtomicInteger VERIFICATIONS = new AtomicInteger();
    private static final AtomicLong CHARGED = new AtomicLong();
    private static final AtomicLong TRANSACTION = new AtomicLong();
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
                // The provider has accepted the request but the hosted-link response never reaches the API.
            }
        });
        provider.createContext("/v3/transactions/", FlutterwaveCheckoutIntegrationTest::verify);
        provider.start();
        return new FlutterwavePaymentGateway(URI.create("http://127.0.0.1:" + provider.getAddress().getPort()),
            URI.create("https://localhost/payment-return"), FIXTURE_KEY, WIRE_JSON, Clock.systemUTC(), 1000, 1000);
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
        JsonNode session = json.readTree(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk())
            .andReturn().getResponse().getContentAsByteArray());
        guestSession = UUID.fromString(session.path("sessionId").asString());
        String guest = session.path("accessToken").asString();
        var quoteInput = new QuoteInput(store, SLOT, List.of(new CartLine(SKU, List.of(), 1, TOTAL)));
        String quote = json.readTree(api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, "Bearer " + guest)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(quoteInput)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(TOTAL))
            .andReturn().getResponse().getContentAsByteArray()).path("quoteId").asString();
        String order = json.readTree(api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, "Bearer " + guest)
            .header(KEY, "wire-order").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new OrderInput(quote, "+250700000000", "payment-wire@example.test"))))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray()).path("id").asString();

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

        CHARGED.set(TOTAL + 25);
        api.perform(post(webhook).header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON).content(event))
            .andExpect(status().isOk());
        String pickupCode = json.readTree(api.perform(get(orderPath).header(HttpHeaders.AUTHORIZATION, "Bearer " + guest))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("paid"))
            .andReturn().getResponse().getContentAsByteArray()).path("pickupCode").asString();
        assertThat(pickupCode).matches("[0-9]{6}");
        api.perform(post(webhook).header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON).content(event))
            .andExpect(status().isOk());
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
        jdbc.sql("INSERT INTO operator_accounts (id, store_id, username, role, password_hash) VALUES (?, ?, ?, 'kitchen', 'fixture')")
            .params(operator, store, store).update();
        jdbc.sql("INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES (?, ?, now() + interval '15 minutes')")
            .params(hash, operator).update();
        return token;
    }
}
