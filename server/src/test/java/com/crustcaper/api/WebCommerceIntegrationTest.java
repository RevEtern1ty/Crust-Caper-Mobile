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
import static org.springframework.http.HttpMethod.PUT;
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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
import org.springframework.transaction.support.TransactionTemplate;
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
    private static final String CHECKOUT_RECOVERY = WEB + "/checkout-recovery";
    private static final String NATIVE_CHECKOUT_RECOVERY = API + "/checkout-recovery";
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
    @Autowired TransactionTemplate transactions;
    @MockitoBean(name = "localGateway", enforceOverride = true) PaymentGateway gateway;

    private final String store = "web-fixture-" + UUID.randomUUID();
    private final List<UUID> guests = new ArrayList<>();

    private record Browser(UUID id, Cookie cookie) {}
    private record NativeGuest(UUID id, String bearer, String refresh) {}
    private record StagedCreate(UUID id, int transactionPid) {}

    @AfterEach
    void removeOnlyFixtures() {
        guests.forEach(guest -> jdbc.sql("DELETE FROM order_access_challenges WHERE guest_session_id = ?")
            .param(guest).update());
        jdbc.sql("DELETE FROM fiscal_receipts WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM order_erasure_requests WHERE store_id = ?").param(store).update();
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
        api.perform(authorized(GET, path + "/data-export", browser)).andExpect(status().isOk())
            .andExpect(jsonPath("$.phone").value(PHONE)).andExpect(jsonPath("$.orderId").value(order.toString()))
            .andExpect(jsonPath("$.paymentAttempt").doesNotExist());
        api.perform(authorized(GET, path + "/data-export", stranger)).andExpect(status().isNotFound());
        String erasure = path + "/erasure-request";
        api.perform(web(PUT, erasure).cookie(browser.cookie()).header(SESSION_HEADER, browser.id().toString()))
            .andExpect(status().isForbidden());
        api.perform(web(PUT, erasure).cookie(browser.cookie()).header(SESSION_HEADER, browser.id().toString())
            .header(HttpHeaders.ORIGIN, FOREIGN_ORIGIN).header(WEB_HEADER, "1")).andExpect(status().isForbidden());
        api.perform(authorized(PUT, erasure, browser)).andExpect(status().isOk())
            .andExpect(jsonPath("$.request.status").value("pending"));
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

    @Test
    void verifiedCheckoutRecoveryRestoresOneWebOrderAndBothSessionsShareOnePaymentAttempt() throws Exception {
        stockFixture();
        var owner = issueBrowser();
        var replacement = issueBrowser();
        var stranger = issueBrowser();
        String quote = quote(authorized(POST, QUOTES, owner));
        String createKey = UUID.randomUUID().toString();
        UUID order = UUID.fromString(body(submitOrder(authorized(POST, ORDERS, owner), quote, createKey)
            .andExpect(status().isOk())).path("id").asString());
        String orderPath = ORDERS + "/" + order;

        String anotherQuote = quote(authorized(POST, QUOTES, owner));
        String otherOrder = body(submitOrder(authorized(POST, ORDERS, owner), anotherQuote, UUID.randomUUID().toString())
            .andExpect(status().isOk())).path("id").asString();
        api.perform(authorized(GET, orderPath, replacement)).andExpect(status().isNotFound());
        recoverCheckout(replacement, quote, UUID.randomUUID().toString(), PHONE).andExpect(status().isNotFound());
        recoverCheckout(replacement, anotherQuote, createKey, PHONE).andExpect(status().isNotFound());

        var wrongContact = checkoutChallenge(replacement, quote, createKey, "+250700000001");
        awaitChallengeState(wrongContact, "closed");
        verifyChallenge(replacement, wrongContact).andExpect(status().isNotFound());
        api.perform(authorized(GET, orderPath, replacement)).andExpect(status().isNotFound());
        api.perform(authorized(POST, orderPath + "/payments", replacement).header(KEY, "premature-payment"))
            .andExpect(status().isNotFound());

        var challenge = checkoutChallenge(replacement, quote, createKey, PHONE);
        assertThat(challenge).isNotEqualTo(wrongContact);
        awaitDelivery(challenge);
        assertThat(checkoutChallenge(replacement, quote, createKey, PHONE)).isEqualTo(challenge);
        verifyChallenge(stranger, challenge).andExpect(status().isNotFound());
        verifyChallenge(replacement, challenge, "000000").andExpect(status().isNotFound());
        api.perform(authorized(GET, orderPath, replacement)).andExpect(status().isNotFound());
        for (int replay = 0; replay < 2; replay++) {
            verifyChallenge(replacement, challenge).andExpect(status().isOk())
                .andExpect(jsonPath("$.orderId").value(order.toString()));
        }
        api.perform(authorized(GET, orderPath + "/data-export", replacement)).andExpect(status().isNotFound());
        api.perform(authorized(PUT, orderPath + "/erasure-request", replacement)).andExpect(status().isNotFound());
        api.perform(authorized(GET, orderPath, replacement)).andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(order.toString())).andExpect(jsonPath("$.recoveryReadOnly").doesNotExist())
            .andExpect(jsonPath("$.paymentStatus").value("unpaid"));
        api.perform(authorized(GET, ORDERS + "/" + otherOrder, replacement)).andExpect(status().isNotFound());
        api.perform(authorized(GET, orderPath, stranger)).andExpect(status().isNotFound());
        api.perform(authorized(GET, ORDERS + "/recovery", replacement).header(KEY, createKey))
            .andExpect(status().isNotFound());
        assertThat(jdbc.sql("SELECT guest_session_id FROM orders WHERE id = ?").param(order)
            .query(UUID.class).single()).isEqualTo(owner.id());

        String paymentPath = orderPath + "/payments";
        String paymentKey = UUID.randomUUID().toString();
        var providerEntered = new CountDownLatch(1);
        var allowProvider = new CountDownLatch(1);
        when(gateway.open(any())).thenAnswer(invocation -> {
            providerEntered.countDown();
            assertThat(allowProvider.await(10, TimeUnit.SECONDS)).isTrue();
            return new PaymentGateway.HostedPayment(CHECKOUT);
        });
        String attempt;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var recoveredPayment = executor.submit(() -> body(api.perform(authorized(POST, paymentPath, replacement)
                .header(KEY, paymentKey)).andExpect(status().isOk())));
            try {
                assertThat(providerEntered.await(5, TimeUnit.SECONDS)).isTrue();
                api.perform(authorized(POST, paymentPath, owner).header(KEY, "concurrent-original-payment"))
                    .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("payment_pending"));
                var originalRetry = body(api.perform(authorized(POST, paymentPath, owner).header(KEY, paymentKey))
                    .andExpect(status().isOk()));
                attempt = originalRetry.path("id").asString();
                assertThat(originalRetry.path("status").asString()).isEqualTo("processing");
            } finally {
                allowProvider.countDown();
            }
            assertThat(recoveredPayment.get(5, TimeUnit.SECONDS).path("id").asString()).isEqualTo(attempt);
        }
        verify(gateway).open(argThat(input -> input.checkoutChannel() == PaymentGateway.CheckoutChannel.WEB
            && input.reference().equals(attempt)));
        api.perform(authorized(GET, orderPath, replacement)).andExpect(status().isOk())
            .andExpect(jsonPath("$.paymentAttempt.id").value(attempt))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(CHECKOUT));
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE order_id = ?")
            .param(order).query(UUID.class).list()).containsExactly(UUID.fromString(attempt));
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE quote_id = ?").param(UUID.fromString(quote))
            .query(Long.class).single()).isEqualTo(1L);
    }

    @Test
    void checkoutRecoveryClearsOnlyAnExpiredUnusedWebQuote() throws Exception {
        stockFixture();
        var owner = issueBrowser();
        var replacement = issueBrowser();
        String quote = quote(authorized(POST, QUOTES, owner));
        String key = UUID.randomUUID().toString();
        var data = Map.of("quoteId", quote, "key", key, "phone", PHONE);
        api.perform(asJson(guarded(POST, CHECKOUT_RECOVERY), data)).andExpect(status().isUnauthorized());
        api.perform(asJson(guarded(POST, CHECKOUT_RECOVERY).cookie(replacement.cookie())
            .header(SESSION_HEADER, owner.id().toString()), data)).andExpect(status().isUnauthorized());
        api.perform(asJson(web(POST, CHECKOUT_RECOVERY).cookie(replacement.cookie())
            .header(HttpHeaders.ORIGIN, FOREIGN_ORIGIN).header(WEB_HEADER, "1")
            .header(SESSION_HEADER, replacement.id().toString()), data)).andExpect(status().isForbidden());
        recoverCheckout(replacement, "invalid-quote", key, PHONE).andExpect(status().isBadRequest());
        recoverCheckout(replacement, UUID.randomUUID().toString(), key, PHONE).andExpect(status().isNotFound());

        var waiting = body(recoverCheckout(replacement, quote, key, PHONE).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store"))));
        assertThat(waiting.path("state").asString()).isEqualTo("waiting");
        assertThat(Instant.parse(waiting.path("retryAt").asString())).isAfter(Instant.now());
        assertThat(waiting.size()).isEqualTo(2);
        expireQuote(quote);
        var unused = body(recoverCheckout(replacement, quote, key, PHONE).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store"))));
        assertThat(unused.path("state").asString()).isEqualTo("not_placed");
        assertThat(unused.size()).isEqualTo(1);
        submitOrder(authorized(POST, ORDERS, owner), quote, key).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("quote_expired"));
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store)
            .query(Long.class).single()).isZero();

        var nativeGuest = issueNative();
        String nativeQuote = quote(nativeRequest(POST, API + "/quotes", nativeGuest));
        submitOrder(nativeRequest(POST, API + "/orders", nativeGuest), nativeQuote, key).andExpect(status().isOk());
        expireQuote(nativeQuote);
        recoverCheckout(replacement, nativeQuote, key, PHONE).andExpect(status().isNotFound());
        String nativeUnused = quote(nativeRequest(POST, API + "/quotes", nativeGuest));
        expireQuote(nativeUnused);
        recoverCheckout(replacement, nativeUnused, key, PHONE).andExpect(status().isNotFound());
    }

    @Test
    void nativeCheckoutRecoveryClearsOnlyAnExpiredUnusedNativeQuote() throws Exception {
        stockFixture();
        var owner = issueNative();
        var replacement = issueNative();
        var browser = issueBrowser();
        String quote = quote(nativeRequest(POST, API + "/quotes", owner));
        String key = UUID.randomUUID().toString();
        var waiting = body(recoverNativeCheckout(replacement, quote, key, PHONE).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(waiting.path("state").asString()).isEqualTo("waiting");
        assertThat(Instant.parse(waiting.path("retryAt").asString())).isAfter(Instant.now());
        assertThat(waiting.size()).isEqualTo(2);

        var data = Map.of("quoteId", quote, "key", key, "phone", PHONE);
        api.perform(asJson(web(POST, NATIVE_CHECKOUT_RECOVERY).cookie(browser.cookie()), data))
            .andExpect(status().isUnauthorized());
        api.perform(asJson(guarded(POST, CHECKOUT_RECOVERY).header(HttpHeaders.AUTHORIZATION, replacement.bearer()), data))
            .andExpect(status().isUnauthorized());
        recoverNativeCheckout(replacement, "invalid-quote", key, PHONE).andExpect(status().isBadRequest());
        recoverNativeCheckout(replacement, quote, "invalid key", PHONE).andExpect(status().isBadRequest());
        recoverNativeCheckout(replacement, quote, key, "invalid-phone").andExpect(status().isBadRequest());
        recoverNativeCheckout(replacement, UUID.randomUUID().toString(), key, PHONE).andExpect(status().isNotFound());

        String webQuote = quote(authorized(POST, QUOTES, browser));
        recoverNativeCheckout(replacement, webQuote, key, PHONE).andExpect(status().isNotFound());
        expireQuote(webQuote);
        recoverNativeCheckout(replacement, webQuote, key, PHONE).andExpect(status().isNotFound());
        String placedWebQuote = quote(authorized(POST, QUOTES, browser));
        submitOrder(authorized(POST, ORDERS, browser), placedWebQuote, key).andExpect(status().isOk());
        jdbc.sql("UPDATE quotes SET web_checkout = false WHERE id = ?").param(UUID.fromString(placedWebQuote)).update();
        recoverNativeCheckout(replacement, placedWebQuote, key, PHONE).andExpect(status().isNotFound());

        expireQuote(quote);
        var unused = body(recoverNativeCheckout(replacement, quote, key, PHONE).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(unused.path("state").asString()).isEqualTo("not_placed");
        assertThat(unused.size()).isEqualTo(1);
        submitOrder(nativeRequest(POST, API + "/orders", owner), quote, key).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("quote_expired"));
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE quote_id = ?").param(UUID.fromString(quote))
            .query(Long.class).single()).isZero();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void nativeCheckoutRecoveryRecoversTheSameOrderAfterOwnerExpiryOrRevocation(boolean revoke) throws Exception {
        stockFixture();
        when(gateway.open(any())).thenReturn(new PaymentGateway.HostedPayment(CHECKOUT));
        var owner = issueNative();
        var replacement = issueNative();
        var browser = issueBrowser();
        String nativeOrders = API + "/orders";
        String quote = quote(nativeRequest(POST, API + "/quotes", owner));
        String key = UUID.randomUUID().toString();
        String order = body(submitOrder(nativeRequest(POST, nativeOrders, owner), quote, key).andExpect(status().isOk()))
            .path("id").asString();
        UUID otherOrder = createNativeOrder(owner, UUID.randomUUID().toString());
        expireQuote(quote);
        if (revoke) {
            api.perform(asJson(web(POST, API + "/guest-sessions/revoke"), Map.of("refreshToken", owner.refresh())))
                .andExpect(status().isNoContent());
        } else {
            jdbc.sql("UPDATE guest_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ?")
                .param(owner.id()).update();
        }

        String orderPath = nativeOrders + "/" + order;
        api.perform(nativeRequest(GET, nativeOrders + "/recovery", owner).header(KEY, key)).andExpect(status().isUnauthorized());
        recoverNativeCheckout(owner, quote, key, PHONE).andExpect(status().isUnauthorized());
        recoverNativeCheckout(replacement, quote, UUID.randomUUID().toString(), PHONE).andExpect(status().isNotFound());
        recoverCheckout(browser, quote, key, PHONE).andExpect(status().isNotFound());

        UUID wrongPhone = nativeCheckoutChallenge(replacement, quote, key, "+250700000001");
        awaitChallengeState(wrongPhone, "closed");
        verifyNativeChallenge(replacement, wrongPhone, OTP).andExpect(status().isNotFound());
        UUID challenge = nativeCheckoutChallenge(replacement, quote, key, PHONE);
        assertThat(nativeCheckoutChallenge(replacement, quote, key, PHONE)).isEqualTo(challenge);
        awaitDelivery(challenge);

        api.perform(nativeRequest(GET, orderPath, replacement)).andExpect(status().isNotFound());
        api.perform(nativeRequest(POST, orderPath + "/payments", replacement).header(KEY, "before-verification"))
            .andExpect(status().isNotFound());
        verifyChallenge(browser, challenge).andExpect(status().isNotFound());
        verifyNativeChallenge(replacement, challenge, "000000").andExpect(status().isNotFound());
        verifyNativeChallenge(replacement, challenge, OTP).andExpect(status().isOk())
            .andExpect(jsonPath("$.orderId").value(order));
        verifyNativeChallenge(replacement, challenge, OTP).andExpect(status().isOk())
            .andExpect(jsonPath("$.orderId").value(order));

        api.perform(nativeRequest(GET, orderPath, replacement)).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("awaiting_payment"));
        api.perform(nativeRequest(GET, orderPath + "/data-export", replacement)).andExpect(status().isNotFound());
        api.perform(nativeRequest(GET, nativeOrders + "/recovery", replacement).header(KEY, key)).andExpect(status().isNotFound());
        api.perform(nativeRequest(GET, nativeOrders + "/" + otherOrder, replacement)).andExpect(status().isNotFound());
        api.perform(authorized(POST, ORDERS + "/" + order + "/payments", browser).header(KEY, "web-writes"))
            .andExpect(status().isNotFound());

        var attempt = body(api.perform(nativeRequest(POST, orderPath + "/payments", replacement).header(KEY, "native-payment"))
            .andExpect(status().isOk())).path("id").asString();
        api.perform(nativeRequest(POST, orderPath + "/payments", replacement).header(KEY, "native-payment"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(attempt));
        api.perform(nativeRequest(POST, orderPath + "/payments", replacement).header(KEY, "extra-attempt"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("payment_pending"));
        verify(gateway).open(argThat(input -> input.checkoutChannel() == PaymentGateway.CheckoutChannel.MOBILE
            && input.reference().equals(attempt)));
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE order_id = ?").param(UUID.fromString(order))
            .query(UUID.class).list()).containsExactly(UUID.fromString(attempt));
        assertThat(jdbc.sql("""
            SELECT EXISTS (SELECT FROM orders WHERE id = ? AND quote_id = ? AND guest_session_id = ? AND request_key = ?
                AND mobile_checkout_guest_session_id = ? AND web_checkout_guest_session_id IS NULL)
            """).params(UUID.fromString(order), UUID.fromString(quote), owner.id(), key, replacement.id())
            .query(Boolean.class).single()).isTrue();
    }

    @Test
    void olderVerifiedNativeChallengeCannotRestoreAReplacedCheckoutGrant() throws Exception {
        stockFixture();
        when(gateway.open(any())).thenReturn(new PaymentGateway.HostedPayment(CHECKOUT));
        var owner = issueNative();
        var firstGuest = issueNative();
        var nextGuest = issueNative();
        String nativeOrders = API + "/orders";
        String quote = quote(nativeRequest(POST, API + "/quotes", owner));
        String key = UUID.randomUUID().toString();
        String order = body(submitOrder(nativeRequest(POST, nativeOrders, owner), quote, key).andExpect(status().isOk()))
            .path("id").asString();
        String orderPath = nativeOrders + "/" + order;

        UUID first = nativeCheckoutChallenge(firstGuest, quote, key, PHONE);
        awaitDelivery(first);
        verifyNativeChallenge(firstGuest, first, OTP).andExpect(status().isOk());
        var attempt = body(api.perform(nativeRequest(POST, orderPath + "/payments", firstGuest).header(KEY, "first-guest"))
            .andExpect(status().isOk())).path("id").asString();
        jdbc.sql("UPDATE order_access_challenges SET reserved_at = clock_timestamp() - interval '12 minutes' WHERE id = ?")
            .param(first).update();

        UUID next = nativeCheckoutChallenge(nextGuest, quote, key, PHONE);
        awaitDelivery(next);
        verifyNativeChallenge(nextGuest, next, OTP).andExpect(status().isOk());
        verifyNativeChallenge(firstGuest, first, OTP).andExpect(status().isNotFound());
        api.perform(nativeRequest(GET, orderPath, firstGuest)).andExpect(status().isOk())
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").isEmpty());
        api.perform(nativeRequest(POST, orderPath + "/payments", firstGuest).header(KEY, "first-guest"))
            .andExpect(status().isNotFound());
        api.perform(nativeRequest(POST, orderPath + "/payments", nextGuest).header(KEY, "first-guest"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(attempt));
        assertThat(jdbc.sql("SELECT mobile_checkout_guest_session_id FROM orders WHERE id = ?").param(UUID.fromString(order))
            .query(UUID.class).single()).isEqualTo(nextGuest.id());
        verify(gateway).open(argThat(input -> input.checkoutChannel() == PaymentGateway.CheckoutChannel.MOBILE
            && input.reference().equals(attempt)));
    }

    @Test
    void checkoutRecoveryWaitsForTheOriginalCreateTransactionBeforeResolvingAnExpiredQuote() throws Exception {
        stockFixture();
        var owner = issueBrowser();
        var replacement = issueBrowser();
        String quote = quote(authorized(POST, QUOTES, owner));
        String key = UUID.randomUUID().toString();
        var insertion = new CompletableFuture<StagedCreate>();
        var allowCommit = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var creator = executor.submit(() -> transactions.executeWithoutResult(status -> {
                try {
                    var order = orders.createWebOrder(owner.id(), key,
                        new ApiModels.OrderInput(quote, PHONE, "web-race@example.test"));
                    int pid = jdbc.sql("SELECT pg_backend_pid()").query(Integer.class).single();
                    insertion.complete(new StagedCreate(order.id(), pid));
                    assertThat(allowCommit.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted before committing the fixture order", error);
                } catch (RuntimeException | Error failure) {
                    insertion.completeExceptionally(failure);
                    throw failure;
                }
            }));
            var staged = insertion.get(5, TimeUnit.SECONDS);
            var recovery = executor.submit(() -> {
                // The create transaction has read the quote and inserted the order but has not committed.
                expireQuote(quote);
                return body(recoverCheckout(replacement, quote, key, PHONE).andExpect(status().isOk()));
            });
            try {
                awaitGuestLock(staged.transactionPid());
                assertThat(recovery.isDone()).isFalse();
            } finally {
                allowCommit.countDown();
            }
            creator.get(5, TimeUnit.SECONDS);
            var recovered = recovery.get(5, TimeUnit.SECONDS);
            assertThat(recovered.path("state").asString()).isEqualTo("verify");
            UUID challenge = UUID.fromString(recovered.path("challengeId").asString());
            awaitDelivery(challenge);
            api.perform(authorized(DELETE, SESSION, owner)).andExpect(status().isNoContent());
            api.perform(authorized(GET, ORDERS + "/" + staged.id(), owner)).andExpect(status().isUnauthorized());
            verifyChallenge(replacement, challenge).andExpect(status().isOk())
                .andExpect(jsonPath("$.orderId").value(staged.id().toString()));
            api.perform(authorized(GET, ORDERS + "/" + staged.id(), replacement)).andExpect(status().isOk())
                .andExpect(jsonPath("$.recoveryReadOnly").doesNotExist());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void nativeCheckoutRecoveryWaitsForTheCreateTransactionAcrossQuoteExpiry(boolean commit) throws Exception {
        stockFixture();
        var owner = issueNative();
        var replacement = issueNative();
        String quote = quote(nativeRequest(POST, API + "/quotes", owner));
        String key = UUID.randomUUID().toString();
        var insertion = new CompletableFuture<StagedCreate>();
        var finishCreate = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var creator = executor.submit(() -> transactions.executeWithoutResult(status -> {
                try {
                    var order = orders.createOrder(owner.id(), key, new ApiModels.OrderInput(quote, PHONE, null));
                    int pid = jdbc.sql("SELECT pg_backend_pid()").query(Integer.class).single();
                    insertion.complete(new StagedCreate(order.id(), pid));
                    assertThat(finishCreate.await(10, TimeUnit.SECONDS)).isTrue();
                    if (!commit) status.setRollbackOnly();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted before finishing the fixture order", error);
                } catch (RuntimeException | Error failure) {
                    insertion.completeExceptionally(failure);
                    throw failure;
                }
            }));
            var staged = insertion.get(5, TimeUnit.SECONDS);
            var recovery = executor.submit(() -> {
                expireQuote(quote);
                return body(recoverNativeCheckout(replacement, quote, key, PHONE).andExpect(status().isOk()));
            });
            try {
                awaitGuestLock(staged.transactionPid());
                assertThat(recovery.isDone()).isFalse();
            } finally {
                finishCreate.countDown();
            }
            creator.get(5, TimeUnit.SECONDS);
            var recovered = recovery.get(5, TimeUnit.SECONDS);
            var persisted = jdbc.sql("SELECT id FROM orders WHERE quote_id = ?").param(UUID.fromString(quote))
                .query(UUID.class).list();
            if (commit) {
                assertThat(recovered.path("state").asString()).isEqualTo("verify");
                assertThat(persisted).containsExactly(staged.id());
                UUID challenge = UUID.fromString(recovered.path("challengeId").asString());
                awaitDelivery(challenge);
                verifyNativeChallenge(replacement, challenge, OTP).andExpect(status().isOk())
                    .andExpect(jsonPath("$.orderId").value(staged.id().toString()));
            } else {
                assertThat(recovered.path("state").asString()).isEqualTo("not_placed");
                assertThat(persisted).isEmpty();
            }
        }
    }

    @Test
    void ordinaryPhoneRecoveryOfAWebOrderStillCannotStartPayment() throws Exception {
        stockFixture();
        var owner = issueBrowser();
        var recipient = issueBrowser();
        String quote = quote(authorized(POST, QUOTES, owner));
        String order = body(submitOrder(authorized(POST, ORDERS, owner), quote, UUID.randomUUID().toString())
            .andExpect(status().isOk())).path("id").asString();
        String code = order.substring(28).toUpperCase(Locale.ROOT);
        var started = body(api.perform(asJson(authorized(POST, CHALLENGES, recipient),
            new OrderAccessController.StartInput(code, PHONE))).andExpect(status().isAccepted()));
        UUID challenge = UUID.fromString(started.path("challengeId").asString());
        awaitDelivery(challenge);
        verifyChallenge(recipient, challenge).andExpect(status().isOk()).andExpect(jsonPath("$.orderId").value(order));
        api.perform(authorized(GET, ORDERS + "/" + order, recipient)).andExpect(status().isOk())
            .andExpect(jsonPath("$.recoveryReadOnly").value(true));
        api.perform(authorized(POST, ORDERS + "/" + order + "/payments", recipient).header(KEY, "read-only"))
            .andExpect(status().isNotFound());
        assertThat(jdbc.sql("SELECT count(*) FROM payment_attempts WHERE order_id = ?").param(UUID.fromString(order))
            .query(Long.class).single()).isZero();
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

    private ResultActions recoverCheckout(Browser browser, String quote, String key, String phone) throws Exception {
        return api.perform(asJson(authorized(POST, CHECKOUT_RECOVERY, browser),
            Map.of("quoteId", quote, "key", key, "phone", phone)));
    }

    private ResultActions recoverNativeCheckout(NativeGuest guest, String quote, String key, String phone) throws Exception {
        return api.perform(asJson(nativeRequest(POST, NATIVE_CHECKOUT_RECOVERY, guest),
            Map.of("quoteId", quote, "key", key, "phone", phone)));
    }

    private UUID nativeCheckoutChallenge(NativeGuest guest, String quote, String key, String phone) throws Exception {
        var response = body(recoverNativeCheckout(guest, quote, key, phone).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(response.path("state").asString()).isEqualTo("verify");
        assertThat(response.size()).isEqualTo(2);
        return UUID.fromString(response.path("challengeId").asString());
    }

    private UUID checkoutChallenge(Browser browser, String quote, String key, String phone) throws Exception {
        var result = body(recoverCheckout(browser, quote, key, phone).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store"))));
        assertThat(result.path("state").asString()).isEqualTo("verify");
        assertThat(result.size()).isEqualTo(2);
        return UUID.fromString(result.path("challengeId").asString());
    }

    private void expireQuote(String quote) {
        jdbc.sql("UPDATE quotes SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ?")
            .param(UUID.fromString(quote)).update();
    }

    private ResultActions verifyChallenge(Browser browser, UUID challenge) throws Exception {
        return verifyChallenge(browser, challenge, OTP);
    }

    private ResultActions verifyChallenge(Browser browser, UUID challenge, String code) throws Exception {
        var result = api.perform(asJson(authorized(POST, CHALLENGES + "/" + challenge + "/verify", browser),
            new OrderAccessController.VerifyInput(code)));
        var initial = result.andReturn();
        return initial.getRequest().isAsyncStarted() ? api.perform(asyncDispatch(initial)) : result;
    }

    private ResultActions verifyNativeChallenge(NativeGuest guest, UUID challenge, String code) throws Exception {
        var result = api.perform(asJson(nativeRequest(POST, API + "/order-access/challenges/" + challenge + "/verify", guest),
            new OrderAccessController.VerifyInput(code)));
        var initial = result.andReturn();
        return initial.getRequest().isAsyncStarted() ? api.perform(asyncDispatch(initial)) : result;
    }

    private void awaitDelivery(UUID challenge) throws InterruptedException {
        awaitChallengeState(challenge, "sent");
    }

    private void awaitChallengeState(UUID challenge, String expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        String latest;
        do {
            latest = jdbc.sql("SELECT state FROM order_access_challenges WHERE id = ?")
                .param(challenge).query(String.class).single();
            if (expected.equals(latest)) return;
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);
        assertThat(latest).isEqualTo(expected);
    }

    private void awaitGuestLock(int originalPid) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            boolean waiting = jdbc.sql("""
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND wait_event_type = 'Lock'
                      AND query LIKE '%guest_sessions%' AND ? = ANY(pg_blocking_pids(pid)))
                """).param(originalPid).query(Boolean.class).single();
            if (waiting) return;
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("Checkout recovery did not wait for the original guest's create transaction");
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
