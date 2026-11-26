package com.crustcaper.api;

import static com.crustcaper.api.EdgeRateLimits.CLIENT_IP;
import static com.crustcaper.api.EdgeRateLimits.EDGE_PROOF;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.ApiModels.CartLine;
import com.crustcaper.api.ApiModels.OrderInput;
import com.crustcaper.api.ApiModels.QuoteInput;
import jakarta.servlet.http.Cookie;
import java.net.URI;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {
    "crustcaper.web.origin=" + CheckoutQuotaIntegrationTest.ORIGIN,
    "crustcaper.order-access.provider=disabled",
    "crustcaper.push.provider=disabled",
    "crustcaper.checkout.quotas.quotes-per-session=2",
    "crustcaper.checkout.quotas.quotes-per-store=3",
    "crustcaper.checkout.quotas.orders-per-session=1",
    "crustcaper.checkout.quotas.orders-per-store=2"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
class CheckoutQuotaIntegrationTest {
    static final String ORIGIN = "https://quota.crustcaper.invalid";
    private static final String API = "/api/v1";
    private static final String SKU = "double-smash";
    private static final String PHONE = "+250700000000";
    private static final String KEY = "Idempotency-Key";
    private static final String EARLY = "quota-early";
    private static final String LATER = "quota-later";
    private static final String LATEST = "quota-latest";
    private static final String PROOF = "34".repeat(32);
    private static final AtomicInteger NETWORK_FIXTURES = new AtomicInteger();

    @Autowired MockMvc api;
    @Autowired ObjectMapper json;
    @MockitoSpyBean JdbcClient jdbc;
    @TestBean(methodName = "fixedEdgeRateLimits") EdgeRateLimits edgeRateLimits;

    private final List<String> stores = new ArrayList<>();
    private final List<UUID> guests = new ArrayList<>();
    private OffsetDateTime initialClock;
    private String store;

    static EdgeRateLimits fixedEdgeRateLimits() {
        var limits = new EnumMap<EdgeRateLimits.Category, Integer>(EdgeRateLimits.Category.class);
        for (var category : EdgeRateLimits.Category.values()) limits.put(category, 120);
        limits.put(EdgeRateLimits.Category.ORDER, 2);
        return new EdgeRateLimits(true, PROOF, limits, 100, () -> 17);
    }

    @BeforeEach
    void fixture() {
        store = fixtureStore();
        initialClock = jdbc.sql("SELECT date_trunc('minute', clock_timestamp()) + interval '5 seconds'")
            .query(OffsetDateTime.class).single();
        checkoutClock(0);
    }

    @AfterEach
    void removeOnlyFixtures() {
        if (jdbc.sql("SELECT to_regclass('checkout_quota_windows') IS NOT NULL").query(Boolean.class).single()) {
            stores.forEach(id -> jdbc.sql("DELETE FROM checkout_quota_windows WHERE scope = 'store' AND subject = ?")
                .param(id).update());
            guests.forEach(id -> jdbc.sql("DELETE FROM checkout_quota_windows WHERE scope = 'session' AND subject = ?")
                .param(id.toString()).update());
        }
        for (String id : stores) {
            for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
                jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(id).update();
            }
            jdbc.sql("DELETE FROM stores WHERE id = ?").param(id).update();
        }
        guests.forEach(id -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(id).update());
    }

    @Test
    void quoteQuotasIsolateSessionsShareStoreAcrossChannelsAndRollOver() throws Exception {
        String other = fixtureStore();
        var mobile = nativeGuest();
        var browser = browserGuest();
        createQuote(nativePost("/quotes", mobile), store, "missing-slot").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("slot_unavailable"));
        quoteId(createQuote(nativePost("/quotes", mobile), store, EARLY));
        quoteId(createQuote(nativePost("/quotes", mobile), store, LATER));
        assertRateLimited(createQuote(nativePost("/quotes", mobile), store, LATEST));
        assertThat(quoteCount(store)).isEqualTo(2);

        quoteId(createQuote(webPost("/quotes", browser), store, EARLY));
        assertRateLimited(createQuote(webPost("/quotes", browser), store, LATER));
        assertThat(quoteCount(store)).isEqualTo(3);
        quoteId(createQuote(webPost("/quotes", browser), other, EARLY));
        assertThat(quoteCount(other)).isOne();

        checkoutClock(1);
        quoteId(createQuote(nativePost("/quotes", mobile), store, LATEST));
        assertThat(quoteCount(store)).isEqualTo(4);
    }

    @Test
    void orderQuotaPreservesExactReplayAndAdmitsOneOfTwoChannelsAtTheStoreLimit() throws Exception {
        var mobile = nativeGuest();
        var anotherMobile = nativeGuest();
        var browser = browserGuest();
        String first = quoteId(createQuote(nativePost("/quotes", mobile), store, EARLY));
        String alternate = quoteId(createQuote(nativePost("/quotes", mobile), store, LATER));
        String quoteWeb = quoteId(createQuote(webPost("/quotes", browser), store, LATER));
        checkoutClock(1);
        String quoteMobile = quoteId(createQuote(nativePost("/quotes", anotherMobile), store, LATEST));
        String firstKey = "quota-first";
        String firstOrder = body(submit(nativePost("/orders", mobile), first, firstKey).andExpect(status().isOk()))
            .path("id").asString();

        assertRateLimited(submit(nativePost("/orders", mobile), alternate, "quota-session-exhausted"));
        assertThat(activeOrders()).containsExactly(firstOrder);
        String webKey = "quota-race-web";
        String mobileKey = "quota-race-mobile";
        var start = new CountDownLatch(1);
        var ready = new CountDownLatch(2);
        MockHttpServletResponse webResponse;
        MockHttpServletResponse mobileResponse;
        try (var workers = Executors.newFixedThreadPool(2)) {
            var web = workers.submit(() -> {
                awaitStart(ready, start);
                return submit(webPost("/orders", browser), quoteWeb, webKey).andReturn().getResponse();
            });
            var nativeOrder = workers.submit(() -> {
                awaitStart(ready, start);
                return submit(nativePost("/orders", anotherMobile), quoteMobile, mobileKey).andReturn().getResponse();
            });
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            webResponse = web.get(10, TimeUnit.SECONDS);
            mobileResponse = nativeOrder.get(10, TimeUnit.SECONDS);
        }
        assertThat(List.of(webResponse.getStatus(), mobileResponse.getStatus())).containsExactlyInAnyOrder(200, 429);
        boolean webWon = webResponse.getStatus() == 200;
        assertRateLimited(webWon ? mobileResponse : webResponse);
        String winner = body(webWon ? webResponse : mobileResponse).path("id").asString();
        assertThat(activeOrders()).containsExactlyInAnyOrder(firstOrder, winner);

        submit(nativePost("/orders", mobile), first, firstKey)
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(firstOrder));
        submit(nativePost("/orders", mobile), alternate, firstKey)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("conflict"));
        submit(nativePost("/orders", mobile), first, "quota-different-key")
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("conflict"));
        assertThat(activeOrders()).containsExactlyInAnyOrder(firstOrder, winner);
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store).query(Long.class).single())
            .isEqualTo(2);

        checkoutClock(2);
        ResultActions retry = webWon
            ? submit(nativePost("/orders", anotherMobile), quoteMobile, mobileKey)
            : submit(webPost("/orders", browser), quoteWeb, webKey);
        String recovered = body(retry.andExpect(status().isOk())).path("id").asString();
        assertThat(activeOrders()).containsExactlyInAnyOrder(firstOrder, winner, recovered);
    }

    @Test
    void aQuoteExpiringDuringAdmissionLeavesNoOrderOrQuotaCharge() throws Exception {
        var buyer = nativeGuest();
        var quote = body(createQuote(nativePost("/quotes", buyer), store, EARLY).andExpect(status().isOk()));
        OffsetDateTime quoteExpiresAt = OffsetDateTime.parse(quote.path("expiresAt").asString());
        checkoutClock(quoteExpiresAt.minusSeconds(1), quoteExpiresAt.plusSeconds(1));

        submit(nativePost("/orders", buyer), quote.path("quoteId").asString(), "quota-expiring-quote")
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_expired"));

        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("""
            SELECT count(*) FROM checkout_quota_windows WHERE operation = 'order'
              AND ((scope = 'store' AND subject = ?) OR (scope = 'session' AND subject = ?))
            """).params(store, guests.getLast().toString()).query(Long.class).single()).isZero();
        assertThat(quoteCount(store)).isOne();
    }

    @Test
    void networkNewOrderLimitSpansChannelsAndPreservesExactReplayAndConflict() throws Exception {
        String localOrigin = "http://127.0.0.1:8765";
        api.perform(options(API + "/orders").header(HttpHeaders.ORIGIN, localOrigin)
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, "Authorization, Idempotency-Key, Content-Type"))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, localOrigin));

        String other = fixtureStore();
        var mobile = nativeGuest();
        var browser = browserGuest();
        var anotherMobile = nativeGuest();
        String mobileQuote = quoteId(createQuote(nativePost("/quotes", mobile), store, EARLY));
        String webQuote = quoteId(createQuote(webPost("/quotes", browser), store, LATER));
        String rejectedQuote = quoteId(createQuote(nativePost("/quotes", anotherMobile), other, LATEST));
        String sameNetwork = "198.51.100.7";
        String mobileKey = "network-mobile-order";
        String webKey = "network-web-order";
        String mobileOrder = body(submit(nativePost("/orders", mobile, sameNetwork), mobileQuote, mobileKey)
            .andExpect(status().isOk())).path("id").asString();
        String webOrder = body(submit(webPost("/orders", browser, sameNetwork), webQuote, webKey)
            .andExpect(status().isOk())).path("id").asString();

        var rejected = submit(nativePost("/orders", anotherMobile, sameNetwork).header(HttpHeaders.ORIGIN, localOrigin),
            rejectedQuote, "network-third-order").andExpect(header().string(HttpHeaders.RETRY_AFTER, "43"))
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, localOrigin))
            .andExpect(result -> assertThat(result.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS))
                .contains(HttpHeaders.RETRY_AFTER));
        assertRateLimited(rejected);
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(other).query(Long.class).single())
            .isZero();

        submit(nativePost("/orders", mobile, sameNetwork), mobileQuote, mobileKey)
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(mobileOrder));
        submit(webPost("/orders", browser, sameNetwork), webQuote, webKey)
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(webOrder));
        submit(nativePost("/orders", mobile, sameNetwork), rejectedQuote, mobileKey)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("conflict"));
        assertThat(activeOrders()).containsExactlyInAnyOrder(mobileOrder, webOrder);

        submit(nativePost("/orders", anotherMobile), rejectedQuote, "network-third-order").andExpect(status().isOk());
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(other).query(Long.class).single())
            .isOne();
    }

    private void checkoutClock(long minutes) {
        OffsetDateTime pinned = initialClock.plusMinutes(minutes);
        checkoutClock(pinned, pinned);
    }

    private void checkoutClock(OffsetDateTime firstRead, OffsetDateTime laterRead) {
        // PostgreSQL still executes the business statements and quota writes.
        var clock = mock(JdbcClient.StatementSpec.class, RETURNS_DEEP_STUBS);
        when(clock.query(OffsetDateTime.class).single()).thenReturn(firstRead, laterRead);
        doReturn(clock).when(jdbc).sql("SELECT clock_timestamp()");
    }

    private String fixtureStore() {
        String id = "quota-test-" + UUID.randomUUID();
        stores.add(id);
        assertThat(jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(id).update()).isOne();
        assertThat(jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, jsonb_set(product, '{available}', 'true')
            FROM menu_products WHERE store_id = 'kigali' AND sku = ?
            """).params(id, SKU).update()).isOne();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '35 minutes', now() + interval '45 minutes', 5),
                   (?, ?, now() + interval '55 minutes', now() + interval '65 minutes', 5),
                   (?, ?, now() + interval '75 minutes', now() + interval '85 minutes', 5)
            """).params(id, EARLY, id, LATER, id, LATEST).update();
        return id;
    }

    private NativeGuest nativeGuest() throws Exception {
        String address = networkFixture();
        JsonNode session = body(api.perform(edge(post(API + "/guest-sessions"), address)).andExpect(status().isOk()));
        guests.add(UUID.fromString(session.path("sessionId").asString()));
        return new NativeGuest("Bearer " + session.path("accessToken").asString(), address);
    }

    private BrowserGuest browserGuest() throws Exception {
        String address = networkFixture();
        var response = api.perform(edge(guardedWebPost("/session"), address)).andExpect(status().isOk()).andReturn().getResponse();
        UUID id = UUID.fromString(body(response).path("sessionId").asString());
        Cookie cookie = response.getCookie("__Host-crustcaper-web");
        assertThat(cookie).isNotNull();
        guests.add(id);
        return new BrowserGuest(id, cookie, address);
    }

    private static MockHttpServletRequestBuilder nativePost(String path, NativeGuest guest) {
        return nativePost(path, guest, guest.sourceAddress());
    }

    private static MockHttpServletRequestBuilder nativePost(String path, NativeGuest guest, String address) {
        return edge(post(API + path).header(HttpHeaders.AUTHORIZATION, guest.bearer()), address);
    }

    private static MockHttpServletRequestBuilder guardedWebPost(String path) {
        return post(URI.create(ORIGIN + API + "/web" + path)).secure(true)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CrustCaper-Web", "1");
    }

    private static MockHttpServletRequestBuilder webPost(String path, BrowserGuest guest) {
        return webPost(path, guest, guest.sourceAddress());
    }

    private static MockHttpServletRequestBuilder webPost(String path, BrowserGuest guest, String address) {
        return edge(guardedWebPost(path).cookie(guest.cookie()).header("X-CrustCaper-Session", guest.id().toString()), address);
    }

    private static MockHttpServletRequestBuilder edge(MockHttpServletRequestBuilder request, String address) {
        return request.header(EDGE_PROOF, PROOF).header(CLIENT_IP, address);
    }

    private static String networkFixture() {
        return "2001:db8:1:" + Integer.toHexString(NETWORK_FIXTURES.incrementAndGet()) + "::1";
    }

    private static void awaitStart(CountDownLatch ready, CountDownLatch start) throws InterruptedException {
        ready.countDown();
        assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
    }

    private ResultActions createQuote(MockHttpServletRequestBuilder request, String store, String slot) throws Exception {
        var input = new QuoteInput(store, slot, List.of(new CartLine(SKU, List.of(), 1, 9200)));
        return api.perform(request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(input)));
    }

    private String quoteId(ResultActions response) throws Exception {
        return body(response.andExpect(status().isOk())
            .andExpect(jsonPath("$.lines[0].sku").value(SKU))).path("quoteId").asString();
    }

    private ResultActions submit(MockHttpServletRequestBuilder request, String quote, String key) throws Exception {
        return api.perform(request.header(KEY, key).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new OrderInput(quote, PHONE, null))));
    }

    private void assertRateLimited(ResultActions actions) throws Exception {
        assertRateLimited(actions.andExpect(status().isTooManyRequests())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")).andReturn().getResponse());
    }

    private void assertRateLimited(MockHttpServletResponse response) throws Exception {
        assertThat(response.getStatus()).isEqualTo(429);
        assertThat(body(response).path("code").asString()).isEqualTo("rate_limited");
        String retry = response.getHeader(HttpHeaders.RETRY_AFTER);
        assertThat(retry).matches("[0-9]{1,2}");
        assertThat(Integer.parseInt(retry)).isBetween(1, 60);
    }

    private long quoteCount(String store) {
        return jdbc.sql("SELECT count(*) FROM quotes WHERE store_id = ?").param(store).query(Long.class).single();
    }

    private List<String> activeOrders() {
        return jdbc.sql("""
            SELECT id::text FROM orders WHERE store_id = ? AND status = 'awaiting_payment'
              AND reservation_expires_at > clock_timestamp()
            """).param(store).query(String.class).list();
    }

    private JsonNode body(ResultActions actions) throws Exception {
        return body(actions.andReturn().getResponse());
    }

    private JsonNode body(MockHttpServletResponse response) throws Exception {
        return json.readTree(response.getContentAsByteArray());
    }

    private record NativeGuest(String bearer, String sourceAddress) {}
    private record BrowserGuest(UUID id, Cookie cookie, String sourceAddress) {}
}
