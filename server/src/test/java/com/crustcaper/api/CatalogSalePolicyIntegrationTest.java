package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import jakarta.servlet.http.Cookie;
import java.net.URI;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {
    "crustcaper.web.origin=" + CatalogSalePolicyIntegrationTest.ORIGIN,
    "crustcaper.order-access.provider=disabled",
    "crustcaper.push.provider=disabled"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
class CatalogSalePolicyIntegrationTest {
    static final String ORIGIN = "https://shop.crustcaper.invalid";
    private static final String ROOT = "/api/v1";
    private static final String WEB = ROOT + "/web";
    private static final String COOKIE = "__Host-crustcaper-web";
    private static final String BOTH = "double-smash";
    private static final String WEB_ONLY = "web-recipe";
    private static final String MOBILE_ONLY = "mobile-recipe";
    private static final String SLOT = "sale-policy-slot";
    private static final String PHONE = "+250700000000";
    private static final String MONDAY_WINDOW = """
        [{"day":1,"start":"12:00","end":"13:00"}]
        """;

    @Autowired MockMvc api;
    @MockitoSpyBean JdbcClient jdbc;
    @Autowired ObjectMapper json;

    private final String store = "sale-policy-" + UUID.randomUUID();
    private final List<UUID> guests = new ArrayList<>();

    private record BrowserGuest(UUID id, Cookie cookie) {}

    @BeforeEach
    void stockFixture() {
        assertThat(jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update()).isOne();
        var stock = List.of(BOTH, WEB_ONLY, MOBILE_ONLY);
        for (int index = 0; index < stock.size(); index++) {
            String sku = stock.get(index);
            assertThat(jdbc.sql("""
                INSERT INTO menu_products (store_id, sku, position, product)
                SELECT ?, ?, ?, jsonb_set(product, '{sku}', to_jsonb(CAST(? AS text)))
                FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
                """).params(store, sku, index + 1, sku).update()).isOne();
        }
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '45 minutes', now() + interval '55 minutes', 5)
            """).params(store, SLOT).update();
    }

    @AfterEach
    void removeFixtureOnly() {
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void defaultMenuUsesMobileWhileEtagsKeepChannelRepresentationsSeparate() throws Exception {
        channels(WEB_ONLY, "web");
        channels(MOBILE_ONLY, "mobile");
        String path = ROOT + "/stores/" + store + "/menu";
        var defaultMenu = api.perform(get(path)).andExpect(status().isOk());
        assertThat(skus(body(defaultMenu).path("products"))).containsExactly(BOTH, MOBILE_ONLY);
        String mobileTag = defaultMenu.andReturn().getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(mobileTag).isNotBlank();
        api.perform(get(path).param("channel", "mobile").header(HttpHeaders.IF_NONE_MATCH, mobileTag))
            .andExpect(status().isNotModified());
        var webMenu = api.perform(get(path).param("channel", "web").header(HttpHeaders.IF_NONE_MATCH, mobileTag))
            .andExpect(status().isOk());
        assertThat(skus(body(webMenu).path("products"))).containsExactly(BOTH, WEB_ONLY);
        String webTag = webMenu.andReturn().getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(webTag).isNotBlank().isNotEqualTo(mobileTag);
        api.perform(get(path).param("channel", "web").header(HttpHeaders.IF_NONE_MATCH, webTag))
            .andExpect(status().isNotModified());
    }

    @Test
    void kigaliWindowsAreHalfOpenAndOffHoursKeepEligibleProductsVisible() throws Exception {
        assertThat(jdbc.sql("""
            SELECT catalog_sale_active(CAST(:hours AS jsonb), candidate.sold_at)
            FROM (VALUES
                (1, TIMESTAMPTZ '2026-01-05 09:59:59Z'),
                (2, TIMESTAMPTZ '2026-01-05 10:00:00Z'),
                (3, TIMESTAMPTZ '2026-01-05 10:59:59Z'),
                (4, TIMESTAMPTZ '2026-01-05 11:00:00Z'),
                (5, TIMESTAMPTZ '2026-01-06 10:00:00Z')
            ) AS candidate(position, sold_at) ORDER BY candidate.position
            """).param("hours", MONDAY_WINDOW).query(Boolean.class).list())
            .containsExactly(false, true, true, false, false);

        channels(WEB_ONLY, "web");
        String path = ROOT + "/stores/" + store + "/menu";
        var before = api.perform(get(path).param("channel", "web")).andExpect(status().isOk())
            .andExpect(jsonPath("$.products[1].sku").value(WEB_ONLY))
            .andExpect(jsonPath("$.products[1].available").value(true));
        String beforeTag = before.andReturn().getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(beforeTag).isNotBlank();
        hours(WEB_ONLY, closedWindow());
        var after = api.perform(get(path).param("channel", "web").header(HttpHeaders.IF_NONE_MATCH, beforeTag))
            .andExpect(status().isOk()).andExpect(jsonPath("$.products[1].sku").value(WEB_ONLY))
            .andExpect(jsonPath("$.products[1].available").value(false));
        assertThat(after.andReturn().getResponse().getHeader(HttpHeaders.ETAG)).isNotBlank().isNotEqualTo(beforeTag);
        assertThat(body(after).path("version").asString()).isEqualTo(body(before).path("version").asString());
    }

    @Test
    void nativeAndWebQuoteRoutesReconcileTheirOwnChannelsAndInactiveProducts() throws Exception {
        var nativeGuest = nativeGuest();
        var browser = browserGuest();
        channels(WEB_ONLY, "web");
        channels(MOBILE_ONLY, "mobile");
        hours(MOBILE_ONLY, closedWindow());

        JsonNode nativeQuote = body(quote(nativeWrite("/quotes", nativeGuest).param("channel", "web"),
            BOTH, WEB_ONLY, MOBILE_ONLY).andExpect(status().isOk()));
        assertThat(skus(nativeQuote.path("lines"))).containsExactly(BOTH);
        assertThat(skus(nativeQuote.path("changes"))).containsExactly(WEB_ONLY, MOBILE_ONLY);
        assertThat(nativeQuote.path("changes").get(0).path("kind").asString()).isEqualTo("unavailable");
        assertThat(nativeQuote.path("changes").get(1).path("kind").asString()).isEqualTo("unavailable");

        JsonNode browserQuote = body(quote(webWrite("/quotes", browser).param("channel", "mobile"),
            WEB_ONLY, MOBILE_ONLY).andExpect(status().isOk()));
        assertThat(skus(browserQuote.path("lines"))).containsExactly(WEB_ONLY);
        assertThat(skus(browserQuote.path("changes"))).containsExactly(MOBILE_ONLY);
        assertThat(browserQuote.path("changes").get(0).path("kind").asString()).isEqualTo("unavailable");
        assertThat(storedWebQuote(nativeQuote)).isFalse();
        assertThat(storedWebQuote(browserQuote)).isTrue();

        JsonNode excluded = body(quote(nativeWrite("/quotes", nativeGuest), WEB_ONLY).andExpect(status().isOk()));
        assertThat(skus(excluded.path("lines"))).isEmpty();
        assertThat(excluded.path("total").asLong()).isZero();
        confirm(nativeWrite("/orders", nativeGuest), excluded, key())
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));
        assertThat(orderCount()).isZero();
    }

    @Test
    void confirmationRechecksChannelAndClosedHoursWithoutCreatingOrders() throws Exception {
        var nativeGuest = nativeGuest();
        var browser = browserGuest();
        JsonNode nativeQuote = body(quote(nativeWrite("/quotes", nativeGuest), BOTH).andExpect(status().isOk()));
        JsonNode browserQuote = body(quote(webWrite("/quotes", browser), BOTH).andExpect(status().isOk()));
        channels(BOTH, "web");
        confirm(nativeWrite("/orders", nativeGuest).param("channel", "web"), nativeQuote, key())
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));
        hours(BOTH, closedWindow());
        confirm(webWrite("/orders", browser), browserQuote, key())
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));
        assertThat(orderCount()).isZero();
    }

    @Test
    void confirmationAtTheKigaliWindowEndRejectsAnUnexpiredQuote() throws Exception {
        var browser = browserGuest();
        hours(BOTH, MONDAY_WINDOW);
        checkoutClock("2026-01-05T10:59:30Z");
        JsonNode quote = body(quote(webWrite("/quotes", browser), BOTH).andExpect(status().isOk()));
        assertThat(skus(quote.path("lines"))).containsExactly(BOTH);
        assertThat(Instant.parse(quote.path("expiresAt").asString())).isAfter(Instant.parse("2026-01-05T11:00:00Z"));

        checkoutClock("2026-01-05T11:00:00Z");
        confirm(webWrite("/orders", browser), quote, key())
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));
        assertThat(orderCount()).isZero();
    }

    @Test
    void confirmationRejectsAStoredQuoteFromTheWrongChannelForItsOwner() throws Exception {
        var owner = nativeGuest();
        var browser = browserGuest();
        JsonNode nativeQuote = body(quote(nativeWrite("/quotes", owner), BOTH).andExpect(status().isOk()));
        JsonNode browserQuote = body(quote(webWrite("/quotes", browser), BOTH).andExpect(status().isOk()));
        setStoredWebQuote(nativeQuote, true);
        setStoredWebQuote(browserQuote, false);
        confirm(nativeWrite("/orders", owner), nativeQuote, key())
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_expired"));
        confirm(webWrite("/orders", browser), browserQuote, key())
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_expired"));
        assertThat(orderCount()).isZero();
    }

    @Test
    void acceptedOrderReplaysAfterPolicyChangesAndReorderUsesTheCurrentRoute() throws Exception {
        var owner = nativeGuest();
        var browser = browserGuest();
        JsonNode quote = body(quote(nativeWrite("/quotes", owner), BOTH).andExpect(status().isOk()));
        JsonNode browserQuote = body(quote(webWrite("/quotes", browser), BOTH).andExpect(status().isOk()));
        String requestKey = key();
        JsonNode order = body(confirm(nativeWrite("/orders", owner), quote, requestKey).andExpect(status().isOk()));
        JsonNode browserOrder = body(confirm(webWrite("/orders", browser), browserQuote, key()).andExpect(status().isOk()));
        String orderId = order.path("id").asString();
        jdbc.sql("INSERT INTO order_read_grants (guest_session_id, order_id) VALUES (?, ?)")
            .params(browser.id(), UUID.fromString(orderId)).update();
        channels(BOTH, "web");

        JsonNode replay = body(confirm(nativeWrite("/orders", owner), quote, requestKey).andExpect(status().isOk()));
        assertThat(replay.path("id").asString()).isEqualTo(orderId);
        assertThat(replay.path("lines")).isEqualTo(order.path("lines"));
        assertThat(orderCount()).isEqualTo(2);

        String reorder = "/orders/" + orderId + "/reorder";
        JsonNode mobile = body(api.perform(nativeWrite(reorder, owner).param("channel", "web")).andExpect(status().isOk()));
        assertThat(skus(mobile.path("lines"))).isEmpty();
        assertThat(skus(mobile.path("changes"))).containsExactly(BOTH);
        JsonNode web = body(api.perform(webWrite(reorder, browser).param("channel", "mobile")).andExpect(status().isOk()));
        assertThat(skus(web.path("lines"))).containsExactly(BOTH);
        assertThat(web.path("changes").isEmpty()).isTrue();
        String browserReorder = "/orders/" + browserOrder.path("id").asString() + "/reorder";
        JsonNode browserOwner = body(api.perform(webWrite(browserReorder, browser)).andExpect(status().isOk()));
        assertThat(skus(browserOwner.path("lines"))).containsExactly(BOTH);
        api.perform(nativeWrite(browserReorder, owner)).andExpect(status().isNotFound());
        api.perform(webWrite(reorder, browserGuest())).andExpect(status().isNotFound());
    }

    private void channels(String sku, String channel) {
        jdbc.sql("UPDATE menu_products SET sale_channels = ARRAY[CAST(? AS text)] WHERE store_id = ? AND sku = ?")
            .params(channel, store, sku).update();
    }

    private void hours(String sku, String windows) {
        jdbc.sql("UPDATE menu_products SET sale_hours = CAST(? AS jsonb) WHERE store_id = ? AND sku = ?")
            .params(windows, store, sku).update();
    }

    private String closedWindow() {
        // Pick a weekday three days away in Kigali. The fixture stays closed across midnight without sleeping.
        return jdbc.sql("""
            SELECT jsonb_build_array(jsonb_build_object('day',
                EXTRACT(ISODOW FROM (clock_timestamp() AT TIME ZONE 'Africa/Kigali') + interval '3 days')::integer,
                'start', '12:00', 'end', '13:00'))::text
            """).query(String.class).single();
    }

    private void checkoutClock(String time) {
        // The catalog function and all other reads still execute against PostgreSQL.
        var clock = mock(JdbcClient.StatementSpec.class, RETURNS_DEEP_STUBS);
        when(clock.query(OffsetDateTime.class).single()).thenReturn(OffsetDateTime.parse(time));
        doReturn(clock).when(jdbc).sql("SELECT clock_timestamp()");
    }

    private String nativeGuest() throws Exception {
        JsonNode session = body(api.perform(post(ROOT + "/guest-sessions")).andExpect(status().isOk()));
        UUID id = UUID.fromString(session.path("sessionId").asString());
        guests.add(id);
        return "Bearer " + session.path("accessToken").asString();
    }

    private BrowserGuest browserGuest() throws Exception {
        var response = api.perform(webPost("/session")).andExpect(status().isOk()).andReturn().getResponse();
        UUID id = UUID.fromString(json.readTree(response.getContentAsByteArray()).path("sessionId").asString());
        guests.add(id);
        Cookie cookie = response.getCookie(COOKIE);
        assertThat(cookie).isNotNull();
        return new BrowserGuest(id, cookie);
    }

    private static MockHttpServletRequestBuilder nativeWrite(String path, String bearer) {
        return post(ROOT + path).header(HttpHeaders.AUTHORIZATION, bearer);
    }

    private static MockHttpServletRequestBuilder webPost(String path) {
        return post(URI.create(ORIGIN + WEB + path)).secure(true)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CrustCaper-Web", "1");
    }

    private static MockHttpServletRequestBuilder webWrite(String path, BrowserGuest guest) {
        return webPost(path).cookie(guest.cookie()).header("X-CrustCaper-Session", guest.id().toString());
    }

    private ResultActions quote(MockHttpServletRequestBuilder request, String... skus) throws Exception {
        var lines = Arrays.stream(skus).map(sku -> new ApiModels.CartLine(sku, List.of(), 1, 9200)).toList();
        return api.perform(request.contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new ApiModels.QuoteInput(store, SLOT, lines))));
    }

    private ResultActions confirm(MockHttpServletRequestBuilder request, JsonNode quote, String requestKey) throws Exception {
        return api.perform(request.header("Idempotency-Key", requestKey).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new ApiModels.OrderInput(quote.path("quoteId").asString(), PHONE, null))));
    }

    private boolean storedWebQuote(JsonNode quote) {
        return jdbc.sql("SELECT web_checkout FROM quotes WHERE id = ?")
            .param(UUID.fromString(quote.path("quoteId").asString())).query(Boolean.class).single();
    }

    private void setStoredWebQuote(JsonNode quote, boolean web) {
        jdbc.sql("UPDATE quotes SET web_checkout = ? WHERE id = ?")
            .params(web, UUID.fromString(quote.path("quoteId").asString())).update();
    }

    private long orderCount() {
        return jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store).query(Long.class).single();
    }

    private JsonNode body(ResultActions response) throws Exception {
        return json.readTree(response.andReturn().getResponse().getContentAsByteArray());
    }

    private static List<String> skus(JsonNode lines) {
        List<String> skus = new ArrayList<>();
        lines.forEach(line -> skus.add(line.path("sku").asString()));
        return skus;
    }

    private static String key() {
        return "sale-policy-" + UUID.randomUUID();
    }
}
