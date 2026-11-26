package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.ApiModels.CartLine;
import com.crustcaper.api.ApiModels.OrderInput;
import com.crustcaper.api.ApiModels.QuoteInput;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import jakarta.servlet.http.Cookie;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {
    "crustcaper.web.origin=" + CatalogInventoryIntegrationTest.ORIGIN,
    "crustcaper.order-access.provider=disabled",
    "crustcaper.push.provider=disabled"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
class CatalogInventoryIntegrationTest {
    static final String ORIGIN = "https://inventory.crustcaper.invalid";
    private static final String API = "/api/v1";
    private static final String SKU = "double-smash";
    private static final String EARLY_SLOT = "inventory-early";
    private static final String LATE_SLOT = "inventory-late";
    private static final String PHONE = "+250700000000";
    private static final String KEY = "Idempotency-Key";
    private static final long PRICE = 9200;

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService orders;

    private final String store = "inventory-test-" + UUID.randomUUID();
    private final List<UUID> guests = new ArrayList<>();
    private boolean tracked;

    @BeforeEach
    void createFixtureStore() {
        assertThat(jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update()).isOne();
        assertThat(jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, jsonb_set(product, '{available}', 'true')
            FROM menu_products WHERE store_id = 'kigali' AND sku = ?
            """).params(store, SKU).update()).isOne();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '35 minutes', now() + interval '45 minutes', 5),
                   (?, ?, now() + interval '55 minutes', now() + interval '65 minutes', 5)
            """).params(store, EARLY_SLOT, store, LATE_SLOT).update();
    }

    @AfterEach
    void removeOnlyFixtures() {
        jdbc.sql("""
            DELETE FROM payment_exceptions e USING payment_attempts a, orders o
            WHERE e.attempt_id = a.id AND a.order_id = o.id AND o.store_id = ?
            """).param(store).update();
        jdbc.sql("""
            DELETE FROM payment_attempts a USING orders o WHERE a.order_id = o.id AND o.store_id = ?
            """).param(store).update();
        if (tracked) {
            jdbc.sql("DELETE FROM menu_product_inventory WHERE store_id = ?").param(store).update();
        }
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        guests.forEach(id -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(id).update());
    }

    @Test
    void customersInDifferentChannelsAndSlotsCompeteForTheSameLastUnit() throws Exception {
        trackOneUnit();
        NativeGuest nativeGuest = nativeGuest();
        BrowserGuest browser = browserGuest();
        String nativeQuote = quote(nativePost("/quotes", nativeGuest), EARLY_SLOT);
        String webQuote = quote(webPost("/quotes", browser), LATE_SLOT);
        String nativeKey = "inventory-race-native";
        String webKey = "inventory-race-web";
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        Outcome nativeOrder;
        Outcome webOrder;
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> {
                awaitStart(ready, start);
                return outcome(submit(nativePost("/orders", nativeGuest), nativeQuote, nativeKey));
            });
            var second = executor.submit(() -> {
                awaitStart(ready, start);
                return outcome(submit(webPost("/orders", browser), webQuote, webKey));
            });
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            nativeOrder = first.get(10, TimeUnit.SECONDS);
            webOrder = second.get(10, TimeUnit.SECONDS);
        }

        assertThat(List.of(nativeOrder.status(), webOrder.status())).containsExactlyInAnyOrder(200, 409);
        boolean nativeWon = nativeOrder.status() == 200;
        Outcome winner = nativeWon ? nativeOrder : webOrder;
        Outcome loser = nativeWon ? webOrder : nativeOrder;
        assertThat(loser.body().path("code").asString()).isEqualTo("quote_changed");
        UUID orderId = UUID.fromString(winner.body().path("id").asString());
        assertThat(jdbc.sql("SELECT id FROM orders WHERE store_id = ?").param(store).query(UUID.class).list())
            .containsExactly(orderId);
        assertThat(jdbc.sql("SELECT slot_id FROM orders WHERE id = ?").param(orderId).query(String.class).single())
            .isEqualTo(nativeWon ? EARLY_SLOT : LATE_SLOT);
        assertThat(onHand()).isOne();

        ResultActions replay = nativeWon
            ? submit(nativePost("/orders", nativeGuest), nativeQuote, nativeKey)
            : submit(webPost("/orders", browser), webQuote, webKey);
        replay.andExpect(status().isOk()).andExpect(jsonPath("$.id").value(orderId.toString()));
        assertThat(orderCount()).isOne();
        assertThat(onHand()).isOne();
    }

    @Test
    void expiryReleasesADeclinedHoldAndOnlyOnTimeSettlementConsumesStock() throws Exception {
        trackOneUnit();
        NativeGuest nativeGuest = nativeGuest();
        BrowserGuest browser = browserGuest();
        String firstQuote = quote(nativePost("/quotes", nativeGuest), EARLY_SLOT);
        String nextQuote = quote(webPost("/quotes", browser), LATE_SLOT);
        UUID firstOrder = placedOrder(submit(nativePost("/orders", nativeGuest), firstQuote, "inventory-expired"));
        String firstPayment = payment(nativePost("/orders/" + firstOrder + "/payments", nativeGuest), "inventory-first-payment");
        settle(firstPayment, "declined", PaymentResult.DECLINED);
        api.perform(get(API + "/orders/{id}", firstOrder).header(HttpHeaders.AUTHORIZATION, nativeGuest.bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("declined"));
        submit(webPost("/orders", browser), nextQuote, "inventory-replacement")
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));
        assertThat(onHand()).isOne();
        assertThat(orderCount()).isOne();
        assertMenuAvailability(false);

        String retriedPayment = payment(nativePost("/orders/" + firstOrder + "/payments", nativeGuest), "inventory-late-payment");
        jdbc.sql("UPDATE orders SET reservation_expires_at = clock_timestamp() - interval '1 second' WHERE id = ?")
            .param(firstOrder).update();
        assertMenuAvailability(true);
        UUID replacement = placedOrder(submit(webPost("/orders", browser), nextQuote, "inventory-replacement"));
        assertThat(orderCount()).isEqualTo(2);

        settle(retriedPayment, "late", PaymentResult.PAID);
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
            .param(UUID.fromString(retriedPayment)).query(String.class).single()).isEqualTo("unavailable_reservation");
        assertThat(jdbc.sql("SELECT status || ':' || payment_status FROM orders WHERE id = ?")
            .param(firstOrder).query(String.class).single()).isEqualTo("cancelled:refund_pending");
        assertThat(onHand()).isOne();

        String replacementPayment = payment(webPost("/orders/" + replacement + "/payments", browser), "inventory-replacement-payment");
        settle(replacementPayment, "in-time", PaymentResult.PAID);
        assertThat(onHand()).isZero();
        assertMenuAvailability(false);
        settle(replacementPayment, "in-time", PaymentResult.PAID);
        settle(replacementPayment, "duplicate", PaymentResult.PAID);
        assertThat(onHand()).isZero();
        assertThat(jdbc.sql("SELECT status || ':' || payment_status FROM orders WHERE id = ?")
            .param(replacement).query(String.class).single()).isEqualTo("accepted:paid");
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
            .param(UUID.fromString(replacementPayment)).query(String.class).single()).isEqualTo("duplicate_transaction");
    }

    @Test
    void aQuoteAggregatesQuantitiesAcrossModifierVariantsBeforeOfferingStock() throws Exception {
        trackOneUnit();
        var buyer = nativeGuest();
        var input = new QuoteInput(store, EARLY_SLOT, List.of(
            new CartLine(SKU, List.of(), 1, PRICE),
            new CartLine(SKU, List.of("extra-cheese"), 1, PRICE + 500)));
        api.perform(nativePost("/quotes", buyer).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(input)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.lines").isEmpty())
            .andExpect(jsonPath("$.changes[0].kind").value("unavailable"))
            .andExpect(jsonPath("$.changes[0].sku").value(SKU));
        assertThat(orderCount()).isZero();
        assertThat(onHand()).isOne();
    }

    @Test
    void existingProductsWithoutAnInventoryRowStayOrderable() throws Exception {
        NativeGuest nativeGuest = nativeGuest();
        BrowserGuest browser = browserGuest();
        String nativeQuote = quote(nativePost("/quotes", nativeGuest), EARLY_SLOT);
        String webQuote = quote(webPost("/quotes", browser), LATE_SLOT);
        placedOrder(submit(nativePost("/orders", nativeGuest), nativeQuote, "untracked-native"));
        placedOrder(submit(webPost("/orders", browser), webQuote, "untracked-browser"));
        assertThat(orderCount()).isEqualTo(2);
    }

    private void assertMenuAvailability(boolean available) throws Exception {
        api.perform(get(API + "/stores/{id}/menu", store))
            .andExpect(status().isOk()).andExpect(jsonPath("$.products[0].sku").value(SKU))
            .andExpect(jsonPath("$.products[0].available").value(available));
    }

    private NativeGuest nativeGuest() throws Exception {
        JsonNode session = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk()));
        guests.add(UUID.fromString(session.path("sessionId").asString()));
        return new NativeGuest("Bearer " + session.path("accessToken").asString());
    }

    private BrowserGuest browserGuest() throws Exception {
        var response = api.perform(guardedWebPost("/session")).andExpect(status().isOk()).andReturn().getResponse();
        var id = UUID.fromString(json.readTree(response.getContentAsByteArray()).path("sessionId").asString());
        Cookie cookie = response.getCookie("__Host-crustcaper-web");
        assertThat(cookie).isNotNull();
        guests.add(id);
        return new BrowserGuest(id, cookie);
    }

    private static MockHttpServletRequestBuilder nativePost(String path, NativeGuest guest) {
        return post(API + path).header(HttpHeaders.AUTHORIZATION, guest.bearer());
    }

    private static MockHttpServletRequestBuilder guardedWebPost(String path) {
        return post(URI.create(ORIGIN + API + "/web" + path)).secure(true)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CrustCaper-Web", "1");
    }

    private static MockHttpServletRequestBuilder webPost(String path, BrowserGuest guest) {
        return guardedWebPost(path).cookie(guest.cookie()).header("X-CrustCaper-Session", guest.id().toString());
    }

    private static void awaitStart(CountDownLatch ready, CountDownLatch start) throws InterruptedException {
        ready.countDown();
        assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
    }

    private String quote(MockHttpServletRequestBuilder request, String slot) throws Exception {
        var input = new QuoteInput(store, slot, List.of(new CartLine(SKU, List.of(), 1, PRICE)));
        return body(api.perform(request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(input)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.lines[0].sku").value(SKU))
            .andExpect(jsonPath("$.changes").isEmpty())).path("quoteId").asString();
    }

    private ResultActions submit(MockHttpServletRequestBuilder request, String quote, String key) throws Exception {
        return api.perform(request.header(KEY, key).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new OrderInput(quote, PHONE, null))));
    }

    private UUID placedOrder(ResultActions request) throws Exception {
        return UUID.fromString(body(request.andExpect(status().isOk())).path("id").asString());
    }

    private String payment(MockHttpServletRequestBuilder request, String key) throws Exception {
        return body(api.perform(request.header(KEY, key)).andExpect(status().isOk())).path("id").asString();
    }

    private void settle(String attempt, String suffix, PaymentResult result) {
        orders.settlePayment(new VerifiedPayment(attempt, "inventory-" + attempt + "-" + suffix, PRICE, "RWF", result));
    }

    private void trackOneUnit() {
        jdbc.sql("INSERT INTO menu_product_inventory (store_id, sku, on_hand) VALUES (?, ?, 1)")
            .params(store, SKU).update();
        tracked = true;
    }

    private int onHand() {
        return jdbc.sql("SELECT on_hand FROM menu_product_inventory WHERE store_id = ? AND sku = ?")
            .params(store, SKU).query(Integer.class).single();
    }

    private long orderCount() {
        return jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store).query(Long.class).single();
    }

    private Outcome outcome(ResultActions actions) throws Exception {
        var response = actions.andReturn().getResponse();
        return new Outcome(response.getStatus(), json.readTree(response.getContentAsByteArray()));
    }

    private JsonNode body(ResultActions actions) throws Exception {
        return json.readTree(actions.andReturn().getResponse().getContentAsByteArray());
    }

    private record NativeGuest(String bearer) {}
    private record BrowserGuest(UUID id, Cookie cookie) {}
    private record Outcome(int status, JsonNode body) {}
}
