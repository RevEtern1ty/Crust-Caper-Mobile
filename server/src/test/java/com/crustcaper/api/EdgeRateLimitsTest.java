package com.crustcaper.api;

import static com.crustcaper.api.EdgeRateLimits.CLIENT_IP;
import static com.crustcaper.api.EdgeRateLimits.EDGE_PROOF;
import static com.crustcaper.api.EdgeRateLimits.ORDER_ADMISSION;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup;

import java.time.Duration;
import java.time.Instant;
import java.util.EnumMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.HandlerMapping;

class EdgeRateLimitsTest {
    private static final String PROOF = "12".repeat(32);
    private static final String NATIVE_SESSION = "/api/v1/guest-sessions";
    private static final String WEB_SESSION = "/api/v1/web/session";
    private static final String NATIVE_ORDER = "/api/v1/orders";
    private static final String WEB_ORDER = "/api/v1/web/orders";
    private static final String ADDRESS = "192.0.2.1";

    @Test
    void directedRequestsRequireSingularValidEdgeHeadersAndTheChannelsShareTheSessionBucket() throws Exception {
        var rate = limiter(4, new AtomicLong(7));
        var guests = mock(GuestSessions.class);
        var expires = Instant.parse("2030-01-01T00:00:00Z");
        when(guests.create()).thenReturn(new ApiModels.GuestSession("fixture", expires, "fixture-refresh", expires, null));
        var api = standaloneSetup(new CommerceController(guests, null, null, null),
                new WebCommerceController(null, null, null, null))
            .addInterceptors(rate).setControllerAdvice(new CommerceProblems()).build();

        api.perform(post(NATIVE_SESSION)).andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("forbidden"));
        api.perform(post(NATIVE_SESSION).header(CLIENT_IP, ADDRESS).header(EDGE_PROOF, "34".repeat(32)))
            .andExpect(status().isForbidden());
        api.perform(post(NATIVE_SESSION).header(CLIENT_IP, ADDRESS).header(EDGE_PROOF, PROOF, PROOF))
            .andExpect(status().isForbidden());
        api.perform(post(NATIVE_SESSION).header(EDGE_PROOF, PROOF).header(CLIENT_IP, ADDRESS, "192.0.2.2"))
            .andExpect(status().isForbidden());
        api.perform(post(NATIVE_SESSION).header(EDGE_PROOF, PROOF).header(CLIENT_IP, "192.0.2.999"))
            .andExpect(status().isForbidden());
        api.perform(post(NATIVE_SESSION).header(EDGE_PROOF, PROOF).header(CLIENT_IP, ADDRESS)
                .header("X-Forwarded-For", "192.0.2.2"))
            .andExpect(status().isOk());
        api.perform(post(WEB_SESSION).header(EDGE_PROOF, PROOF).header(CLIENT_IP, ADDRESS)
                .header("X-Forwarded-For", "192.0.2.3"))
            .andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("rate_limited"))
            .andExpect(header().string(HttpHeaders.RETRY_AFTER, "53"))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
        api.perform(post(NATIVE_SESSION).header(EDGE_PROOF, PROOF).header(CLIENT_IP, "192.0.2.2"))
            .andExpect(status().isOk());
    }

    @Test
    void ipv6PrefixesShareTheirBucketAndCapacityNeverEvictsAnActiveNetwork() {
        var seconds = new AtomicLong(59);
        var rate = limiter(2, seconds);
        visit(rate, "POST", NATIVE_SESSION, "2001:db8:1:2::1");
        expectLimited(() -> visit(rate, "POST", WEB_SESSION, "2001:db8:0001:0002:0:0:0:abcd"), 1);
        visit(rate, "POST", NATIVE_SESSION, ADDRESS);
        expectLimited(() -> visit(rate, "POST", NATIVE_SESSION, "2001:db8:1:3::1"), 1);
        expectLimited(() -> visit(rate, "POST", WEB_SESSION, "::ffff:192.0.2.1"), 1);
        expectLimited(() -> visit(rate, "POST", NATIVE_SESSION, "2001:db8:1:2::1"), 1);
        seconds.set(60);
        rate.removeExpiredCounters();
        visit(rate, "POST", NATIVE_SESSION, "2001:db8:1:3::1");
        visit(rate, "POST", NATIVE_SESSION, "2001:db8:1:2::2");
        expectLimited(() -> visit(rate, "POST", WEB_SESSION, ADDRESS), 60);
    }

    @Test
    void otpRecoverySharesStartBudgetAndOrderAdmissionCanFollowReplayHandling() {
        var rate = limiter(3, new AtomicLong());
        visit(rate, "OPTIONS", NATIVE_SESSION, null);
        visit(rate, "POST", "/api/v1/guest-sessions/revoke", null);
        visit(rate, "POST", "/api/v1/webhooks/flutterwave", null);
        visit(rate, "POST", "/api/v1/checkout-recovery", ADDRESS);
        expectLimited(() -> visit(rate, "POST", "/api/v1/web/order-access/challenges", ADDRESS), 60);
        visit(rate, "POST", "/api/v1/order-access/challenges/{id}/verify", ADDRESS);
        expectLimited(() -> visit(rate, "POST", "/api/v1/web/order-access/challenges/{id}/verify", ADDRESS), 60);
        visit(rate, "POST", "/api/v1/operator/sessions", ADDRESS);
        visit(rate, "POST", "/api/v1/web/quotes", ADDRESS);
        expectLimited(() -> visit(rate, "POST", "/api/v1/quotes", ADDRESS), 60);

        // A replay or conflict can return before invoking the new-order admission.
        var first = visit(rate, "POST", NATIVE_ORDER, ADDRESS);
        var second = visit(rate, "POST", WEB_ORDER, ADDRESS);
        ((Runnable) second.getAttribute(ORDER_ADMISSION)).run();
        expectLimited((Runnable) first.getAttribute(ORDER_ADMISSION), 60);
        assertThat(visit(rate, "POST", NATIVE_ORDER, ADDRESS).getAttribute(ORDER_ADMISSION)).isInstanceOf(Runnable.class);
    }

    @Test
    void otpVerificationSpendsOneAdmissionAcrossTheAsyncResponseDispatch() throws Exception {
        var rate = limiter(1, new AtomicLong());
        var guests = mock(GuestSessions.class);
        var access = mock(OrderAccessService.class);
        UUID guest = UUID.randomUUID();
        UUID challenge = UUID.randomUUID();
        UUID order = UUID.randomUUID();
        when(guests.authenticate("Bearer fixture")).thenReturn(guest);
        when(access.verify(guest, challenge, "123456")).thenReturn(new OrderAccessService.VerifiedOrder(order));
        var api = standaloneSetup(new OrderAccessController(guests, access, Duration.ZERO))
            .addInterceptors(rate).setControllerAdvice(new CommerceProblems()).build();
        String verification = "/api/v1/order-access/challenges/" + challenge + "/verify";

        var result = api.perform(post(verification).header(HttpHeaders.AUTHORIZATION, "Bearer fixture")
                .header(EDGE_PROOF, PROOF).header(CLIENT_IP, ADDRESS)
                .contentType(MediaType.APPLICATION_JSON).content("{\"code\":\"123456\"}"))
            .andExpect(request().asyncStarted()).andReturn();
        api.perform(asyncDispatch(result)).andExpect(status().isOk())
            .andExpect(jsonPath("$.orderId").value(order.toString()));
        api.perform(post(verification).header(HttpHeaders.AUTHORIZATION, "Bearer fixture")
                .header(EDGE_PROOF, PROOF).header(CLIENT_IP, ADDRESS)
                .contentType(MediaType.APPLICATION_JSON).content("{\"code\":\"123456\"}"))
            .andExpect(status().isTooManyRequests());
        verify(access).verify(guest, challenge, "123456");
    }

    @Test
    void enabledStartupRequiresConfiguredProofButDisabledModeLeavesRequestsUnchanged() {
        assertThatThrownBy(() -> new EdgeRateLimits(true, "", limits(), 1, () -> 0))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("CRUSTCAPER_EDGE_RATE_PROOF");
        var disabled = new EdgeRateLimits(false, "", limits(), 1, () -> 0);
        assertThat(visit(disabled, "POST", NATIVE_ORDER, null).getAttribute(ORDER_ADMISSION)).isNull();
    }

    private static EdgeRateLimits limiter(int maximumNetworks, AtomicLong clock) {
        return new EdgeRateLimits(true, PROOF, limits(), maximumNetworks, clock::get);
    }

    private static EnumMap<EdgeRateLimits.Category, Integer> limits() {
        var limits = new EnumMap<EdgeRateLimits.Category, Integer>(EdgeRateLimits.Category.class);
        for (var category : EdgeRateLimits.Category.values()) limits.put(category, 1);
        return limits;
    }

    private static MockHttpServletRequest visit(EdgeRateLimits rate, String method, String route, String address) {
        var request = new MockHttpServletRequest(method, route);
        request.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, route);
        if (address != null) {
            request.addHeader(CLIENT_IP, address);
            request.addHeader(EDGE_PROOF, PROOF);
        }
        assertThat(rate.preHandle(request, new MockHttpServletResponse(), new Object())).isTrue();
        return request;
    }

    private static void expectLimited(Runnable action, int retry) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiFailure.class, failure -> {
            assertThat(failure.status()).isEqualTo(429);
            assertThat(failure.retryAfterSeconds()).isEqualTo(retry);
        });
    }
}
