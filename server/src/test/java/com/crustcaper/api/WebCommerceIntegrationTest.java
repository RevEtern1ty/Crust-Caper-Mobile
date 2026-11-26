package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.http.HttpMethod.DELETE;
import static org.springframework.http.HttpMethod.GET;
import static org.springframework.http.HttpMethod.POST;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.crustcaper.api.payment.PaymentGateway;
import jakarta.servlet.http.Cookie;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {
    "crustcaper.web.origin=" + WebCommerceIntegrationTest.ORIGIN,
    "crustcaper.order-access.provider=local",
    "crustcaper.order-access.dispatch-delay=PT0.15S",
    "crustcaper.order-access.negative-delay=PT0S"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
class WebCommerceIntegrationTest {
    static final String ORIGIN = "https://shop.crustcaper.invalid";
    private static final String FOREIGN_ORIGIN = "https://other.crustcaper.invalid";
    private static final String API = "/api/v1";
    private static final String WEB = API + "/web";
    private static final String SESSION = WEB + "/session";
    private static final String QUOTES = WEB + "/quotes";
    private static final String ORDERS = WEB + "/orders";
    private static final String CHALLENGES = WEB + "/order-access/challenges";
    private static final String WEB_HEADER = "X-CrustCaper-Web";
    private static final String SESSION_HEADER = "X-CrustCaper-Session";
    private static final String COOKIE = "__Host-crustcaper-web";
    private static final String KEY = "Idempotency-Key";
    private static final String PHONE = "+250700000000";
    private static final String OTP = "418263";
    private static final String CHECKOUT = "https://checkout.example.invalid/synthetic";
    private static final byte[] PDF = "%PDF-1.7\nSynthetic receipt fixture\n%%EOF\n"
        .getBytes(StandardCharsets.US_ASCII);

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService orders;
    @MockitoBean(name = "localGateway", enforceOverride = true) PaymentGateway gateway;

    private final String store = "web-fixture-" + UUID.randomUUID();
    private final List<UUID> guests = new ArrayList<>();

    private record Browser(UUID id, Cookie cookie) {}
    private record NativeGuest(UUID id, String bearer, String refresh) {}

    @AfterEach
    void removeOnlyFixtures() {
        guests.forEach(guest -> jdbc.sql("DELETE FROM order_access_challenges WHERE guest_session_id = ?")
            .param(guest).update());
        jdbc.sql("DELETE FROM fiscal_receipts WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM operator_accounts WHERE store_id = ?").param(store).update();
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
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void sessionWritesRequireTheExactOriginAndMarkerAndRevocationOnlyAffectsTheMatchingCookie() throws Exception {
        api.perform(web(GET, SESSION)).andExpect(status().isUnauthorized());
        for (var rejected : List.of(
            web(POST, SESSION).header(WEB_HEADER, "1"),
            web(POST, SESSION).header(HttpHeaders.ORIGIN, ORIGIN),
            web(POST, SESSION).header(HttpHeaders.ORIGIN, ORIGIN).header(WEB_HEADER, "0"),
            web(POST, SESSION).header(HttpHeaders.ORIGIN, ORIGIN).header(WEB_HEADER, "1", "1"),
            web(POST, SESSION).header(HttpHeaders.ORIGIN, FOREIGN_ORIGIN).header(WEB_HEADER, "1")
        )) {
            api.perform(rejected).andExpect(status().isForbidden())
                .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
                .andExpect(header().doesNotExist(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN));
        }

        var browser = issueBrowser();
        var foreign = issueBrowser();
        assertThat(browser.id()).isNotEqualTo(foreign.id());
        assertThat(jdbc.sql("SELECT web_token_hash FROM guest_sessions WHERE id = ?")
            .param(browser.id()).query(String.class).single()).hasSize(64).isNotEqualTo(browser.cookie().getValue());
        assertThat(jdbc.sql("SELECT count(*) FROM guest_access_tokens WHERE guest_session_id = ?")
            .param(browser.id()).query(Long.class).single()).isZero();
        api.perform(guarded(POST, SESSION).cookie(browser.cookie())).andExpect(status().isOk())
            .andExpect(jsonPath("$.sessionId").value(browser.id().toString()))
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE));
        api.perform(guarded(POST, SESSION).cookie(browser.cookie()).header(SESSION_HEADER, foreign.id().toString()))
            .andExpect(status().isUnauthorized()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE));
        api.perform(web(GET, SESSION).cookie(browser.cookie(), foreign.cookie())).andExpect(status().isUnauthorized());

        api.perform(guarded(DELETE, SESSION).cookie(browser.cookie())).andExpect(status().isUnauthorized());
        api.perform(guarded(DELETE, SESSION).cookie(browser.cookie()).header(SESSION_HEADER, foreign.id().toString()))
            .andExpect(status().isUnauthorized()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE));
        api.perform(web(DELETE, SESSION).cookie(browser.cookie()).header(SESSION_HEADER, browser.id().toString())
            .header(HttpHeaders.ORIGIN, FOREIGN_ORIGIN).header(WEB_HEADER, "1"))
            .andExpect(status().isForbidden()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE));
        api.perform(web(GET, SESSION).cookie(browser.cookie())).andExpect(status().isOk())
            .andExpect(jsonPath("$.sessionId").value(browser.id().toString()))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store")));
        api.perform(authorized(DELETE, SESSION, browser)).andExpect(status().isNoContent())
            .andExpect(cookie().maxAge(COOKIE, 0));
        api.perform(web(GET, SESSION).cookie(browser.cookie())).andExpect(status().isUnauthorized());
        api.perform(authorized(DELETE, SESSION, browser)).andExpect(status().isNoContent())
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE));
        api.perform(guarded(DELETE, SESSION).header(SESSION_HEADER, browser.id().toString()))
            .andExpect(status().isNoContent()).andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE));
        api.perform(web(GET, SESSION).cookie(foreign.cookie())).andExpect(status().isOk())
            .andExpect(jsonPath("$.sessionId").value(foreign.id().toString()));

        jdbc.sql("UPDATE guest_sessions SET expires_at = now() WHERE id = ?").param(foreign.id()).update();
        api.perform(web(GET, SESSION).cookie(foreign.cookie())).andExpect(status().isUnauthorized());
    }

    @Test
    void lostOrdersAndPaymentResponsesRecoverWithinTheOriginalBrowserContext() throws Exception {
        stockFixture();
        var owner = issueBrowser();
        var foreign = issueBrowser();
        byte[] quoteInput = json.writeValueAsBytes(quoteInput());
        api.perform(guarded(POST, QUOTES).cookie(owner.cookie()).contentType(MediaType.APPLICATION_JSON)
            .content(quoteInput)).andExpect(status().isUnauthorized());
        api.perform(guarded(POST, QUOTES).cookie(owner.cookie()).header(SESSION_HEADER, foreign.id().toString())
            .contentType(MediaType.APPLICATION_JSON).content(quoteInput)).andExpect(status().isUnauthorized());
        api.perform(guarded(POST, QUOTES).header(SESSION_HEADER, owner.id().toString())
            .contentType(MediaType.APPLICATION_JSON).content(quoteInput)).andExpect(status().isUnauthorized());
        api.perform(web(POST, QUOTES).cookie(owner.cookie()).header(SESSION_HEADER, owner.id().toString())
            .header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(quoteInput))
            .andExpect(status().isForbidden());
        assertThat(jdbc.sql("SELECT count(*) FROM quotes WHERE store_id = ?").param(store)
            .query(Long.class).single()).isZero();

        String quote = quote(authorized(POST, QUOTES, owner));
        String orderKey = "browser-create";
        var first = body(submitOrder(authorized(POST, ORDERS, owner), quote, orderKey)
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store"))));
        UUID order = UUID.fromString(first.path("id").asString());
        String orderPath = ORDERS + "/" + order;
        assertThat(jdbc.sql("SELECT checkout_channel FROM orders WHERE id = ?").param(order)
            .query(String.class).single()).isEqualTo("web");
        jdbc.sql("UPDATE quotes SET expires_at = now() WHERE id = ?").param(UUID.fromString(quote)).update();
        submitOrder(authorized(POST, ORDERS, owner), quote, orderKey)
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(order.toString()));
        api.perform(authorized(GET, ORDERS + "/recovery", owner).header(KEY, orderKey))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(order.toString()));
        api.perform(authorized(GET, ORDERS + "/recovery", foreign).header(KEY, orderKey))
            .andExpect(status().isNotFound());
        api.perform(authorized(GET, orderPath, foreign)).andExpect(status().isNotFound());
        api.perform(authorized(POST, orderPath + "/payments", foreign).header(KEY, "browser-payment"))
            .andExpect(status().isNotFound());

        when(gateway.open(any())).thenReturn(new PaymentGateway.HostedPayment(CHECKOUT));
        String paymentPath = orderPath + "/payments";
        var initialPayment = body(api.perform(authorized(POST, paymentPath, owner).header(KEY, "browser-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkoutUrl").value(CHECKOUT)));
        String attempt = initialPayment.path("id").asString();
        api.perform(authorized(POST, paymentPath, owner).header(KEY, "browser-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(attempt));
        api.perform(authorized(GET, ORDERS + "/recovery", owner).header(KEY, orderKey))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentAttempt.id").value(attempt))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(CHECKOUT));
        submitOrder(authorized(POST, ORDERS, owner), quote, orderKey)
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(order.toString()))
            .andExpect(jsonPath("$.paymentAttempt.id").value(attempt));
        verify(gateway).open(argThat(input -> input.checkoutChannel() == PaymentGateway.CheckoutChannel.WEB
            && input.reference().equals(attempt)));
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE order_id = ?")
            .param(order).query(UUID.class).list()).containsExactly(UUID.fromString(attempt));
        assertThat(jdbc.sql("SELECT id FROM orders WHERE store_id = ?").param(store)
            .query(UUID.class).list()).containsExactly(order);
    }

    @Test
    void phoneRecoverySharesOneReadOnlyOrderWithoutIssuingNativeCredentials() throws Exception {
        stockFixture();
        var owner = issueNative();
        var browser = issueBrowser();
        var stranger = issueBrowser();
        UUID order = createNativeOrder(owner, "native-owner");
        UUID another = createNativeOrder(owner, "unrelated");
        String path = ORDERS + "/" + order;
        String nativePath = API + "/orders/" + order;
        when(gateway.open(any())).thenReturn(new PaymentGateway.HostedPayment(CHECKOUT));
        var payment = body(api.perform(nativeRequest(POST, nativePath + "/payments", owner).header(KEY, "native-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkoutUrl").value(CHECKOUT)));
        String attempt = payment.path("id").asString();
        verify(gateway).open(argThat(input -> input.checkoutChannel() == PaymentGateway.CheckoutChannel.MOBILE
            && input.reference().equals(attempt)));
        assertThat(jdbc.sql("SELECT checkout_channel FROM orders WHERE id = ?").param(order)
            .query(String.class).single()).isEqualTo("mobile");
        api.perform(authorized(GET, path, browser)).andExpect(status().isNotFound());

        String code = order.toString().substring(28).toUpperCase(Locale.ROOT);
        var started = body(api.perform(asJson(authorized(POST, CHALLENGES, browser),
            new OrderAccessController.StartInput(code, PHONE))).andExpect(status().isAccepted())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store"))));
        assertThat(started.size()).isEqualTo(1);
        UUID challenge = UUID.fromString(started.path("challengeId").asString());
        awaitDelivery(challenge);
        verifyChallenge(stranger, challenge).andExpect(status().isNotFound());
        var verified = body(verifyChallenge(browser, challenge).andExpect(status().isOk())
            .andExpect(jsonPath("$.orderId").value(order.toString())));
        assertThat(verified.size()).isEqualTo(1);
        api.perform(authorized(GET, path, browser)).andExpect(status().isOk())
            .andExpect(jsonPath("$.recoveryReadOnly").value(true))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").isEmpty());
        api.perform(authorized(POST, path + "/reorder", browser)).andExpect(status().isOk())
            .andExpect(jsonPath("$.lines[0].sku").value("double-smash"));
        api.perform(authorized(GET, ORDERS + "/" + another, browser)).andExpect(status().isNotFound());
        api.perform(authorized(GET, ORDERS + "/recovery", browser).header(KEY, "native-owner"))
            .andExpect(status().isNotFound());
        api.perform(authorized(POST, path + "/payments", browser).header(KEY, "native-payment"))
            .andExpect(status().isNotFound());
        assertThat(jdbc.sql("SELECT guest_session_id FROM orders WHERE id = ?").param(order)
            .query(UUID.class).single()).isEqualTo(owner.id());
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE order_id = ?").param(order)
            .query(UUID.class).list()).containsExactly(UUID.fromString(attempt));

        seedReceipt(order, attempt);
        api.perform(authorized(GET, path, browser)).andExpect(status().isOk())
            .andExpect(jsonPath("$.receiptUrl").value(path + "/receipt"));
        api.perform(authorized(GET, path + "/receipt", browser)).andExpect(status().isOk())
            .andExpect(content().contentType(MediaType.APPLICATION_PDF)).andExpect(content().bytes(PDF))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store")));
        api.perform(authorized(GET, path + "/receipt", stranger)).andExpect(status().isNotFound());
        api.perform(web(GET, path + "/receipt").cookie(browser.cookie())).andExpect(status().isUnauthorized());

        api.perform(web(GET, nativePath).cookie(browser.cookie()).header(SESSION_HEADER, browser.id().toString()))
            .andExpect(status().isUnauthorized());
        api.perform(web(GET, nativePath).header(HttpHeaders.AUTHORIZATION, "Bearer " + browser.cookie().getValue()))
            .andExpect(status().isUnauthorized());
        api.perform(asJson(post(API + "/guest-sessions/refresh"),
            new ApiModels.GuestRefresh(browser.cookie().getValue()))).andExpect(status().isUnauthorized());
        var rotated = body(api.perform(asJson(post(API + "/guest-sessions/refresh"),
            new ApiModels.GuestRefresh(owner.refresh(), UUID.randomUUID().toString()))).andExpect(status().isOk()));
        assertThat(rotated.path("sessionId").asString()).isEqualTo(owner.id().toString());
        assertThat(rotated.path("refreshToken").asString()).isNotEqualTo(owner.refresh());
        api.perform(web(GET, nativePath)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + rotated.path("accessToken").asString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.receiptUrl").value(nativePath + "/receipt"));
    }

    private Browser issueBrowser() throws Exception {
        var response = api.perform(guarded(POST, SESSION)).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store")))
            .andExpect(header().doesNotExist(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN))
            .andExpect(cookie().httpOnly(COOKIE, true)).andExpect(cookie().secure(COOKIE, true))
            .andExpect(cookie().path(COOKIE, "/")).andExpect(cookie().sameSite(COOKIE, "Lax"))
            .andReturn().getResponse();
        Cookie cookie = response.getCookie(COOKIE);
        assertThat(cookie.getDomain()).isNull();
        JsonNode session = json.readTree(response.getContentAsByteArray());
        UUID id = UUID.fromString(session.path("sessionId").asString());
        guests.add(id);
        assertThat(session.size()).isEqualTo(2);
        assertThat(Instant.parse(session.path("expiresAt").asString())).isAfter(Instant.now());
        assertThat(response.getContentAsString()).doesNotContain(cookie.getValue());
        return new Browser(id, cookie);
    }

    private NativeGuest issueNative() throws Exception {
        var session = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk()));
        UUID id = UUID.fromString(session.path("sessionId").asString());
        guests.add(id);
        return new NativeGuest(id, "Bearer " + session.path("accessToken").asString(),
            session.path("refreshToken").asString());
    }

    private UUID createNativeOrder(NativeGuest owner, String key) throws Exception {
        String quote = quote(nativeRequest(POST, API + "/quotes", owner));
        return UUID.fromString(body(submitOrder(nativeRequest(POST, API + "/orders", owner), quote, key)
            .andExpect(status().isOk())).path("id").asString());
    }

    private ApiModels.QuoteInput quoteInput() {
        return new ApiModels.QuoteInput(store, "fixture", List.of(new ApiModels.CartLine("double-smash", List.of(), 1, 9200)));
    }

    private String quote(MockHttpServletRequestBuilder request) throws Exception {
        return body(api.perform(asJson(request, quoteInput())).andExpect(status().isOk())).path("quoteId").asString();
    }

    private ResultActions submitOrder(MockHttpServletRequestBuilder request, String quote, String key) throws Exception {
        return api.perform(asJson(request.header(KEY, key), new ApiModels.OrderInput(quote, PHONE, "web-fixture@example.test")));
    }

    private ResultActions verifyChallenge(Browser browser, UUID challenge) throws Exception {
        var result = api.perform(asJson(authorized(POST, CHALLENGES + "/" + challenge + "/verify", browser),
            new OrderAccessController.VerifyInput(OTP)));
        var initial = result.andReturn();
        return initial.getRequest().isAsyncStarted() ? api.perform(asyncDispatch(initial)) : result;
    }

    private void awaitDelivery(UUID challenge) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        String latest;
        do {
            latest = jdbc.sql("SELECT state FROM order_access_challenges WHERE id = ?")
                .param(challenge).query(String.class).single();
            if ("sent".equals(latest)) return;
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);
        assertThat(latest).isEqualTo("sent");
    }

    private void stockFixture() {
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'fixture', now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).param(store).update();
    }

    private void seedReceipt(UUID order, String attempt) {
        long total = jdbc.sql("SELECT total FROM orders WHERE id = ?").param(order).query(Long.class).single();
        orders.settlePayment(new PaymentGateway.VerifiedPayment(attempt, "local-" + attempt, total, "RWF",
            PaymentGateway.PaymentResult.PAID));
        UUID manager = UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO operator_accounts (id, store_id, username, role, password_hash) VALUES (?, ?, ?, 'manager', 'fixture')
            """).params(manager, store, store).update();
        jdbc.sql("""
            INSERT INTO fiscal_receipts (order_id, store_id, reference, total_rwf, document, attached_by)
            VALUES (?, ?, 'EBM/WEB-FIXTURE', ?, ?, ?)
            """).params(order, store, total, PDF, manager).update();
        jdbc.sql("UPDATE orders SET receipt_status = 'issued', receipt_url = ? WHERE id = ?")
            .params(API + "/orders/" + order + "/receipt", order).update();
    }

    private MockHttpServletRequestBuilder asJson(MockHttpServletRequestBuilder request, Object input) {
        return request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(input));
    }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }

    private static MockHttpServletRequestBuilder web(HttpMethod method, String path) {
        return request(method, URI.create(ORIGIN + path)).secure(true);
    }

    private static MockHttpServletRequestBuilder guarded(HttpMethod method, String path) {
        return web(method, path).header(HttpHeaders.ORIGIN, ORIGIN).header(WEB_HEADER, "1");
    }

    private static MockHttpServletRequestBuilder authorized(HttpMethod method, String path, Browser browser) {
        var request = method.equals(GET) ? web(method, path) : guarded(method, path);
        return request.cookie(browser.cookie()).header(SESSION_HEADER, browser.id().toString());
    }

    private static MockHttpServletRequestBuilder nativeRequest(HttpMethod method, String path, NativeGuest guest) {
        return web(method, path).header(HttpHeaders.AUTHORIZATION, guest.bearer());
    }
}
