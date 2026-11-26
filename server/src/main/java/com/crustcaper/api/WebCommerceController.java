package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.*;
import static com.crustcaper.api.CommerceController.privateResponse;
import static com.crustcaper.api.WebCommerceAccess.GUEST_ATTRIBUTE;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/web")
final class WebCommerceController {
    private static final String KEY = "Idempotency-Key";
    private final WebGuestSessions sessions;
    private final OrderService orders;
    private final OrderAccessController orderAccess;
    private final OrderAccessService access;
    private final CustomerReceiptController receipts;

    WebCommerceController(WebGuestSessions sessions, OrderService orders, OrderAccessController orderAccess,
        OrderAccessService access, CustomerReceiptController receipts) {
        this.sessions = sessions;
        this.orders = orders;
        this.orderAccess = orderAccess;
        this.access = access;
        this.receipts = receipts;
    }

    record CheckoutRecoveryInput(String quoteId, String key, String phone) {
        @Override
        public String toString() { return "WebCheckoutRecovery[redacted]"; }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record CheckoutRecovery(String state, Instant retryAt, UUID challengeId) {}

    @GetMapping("/session")
    ResponseEntity<WebGuestSessions.Session> session(HttpServletRequest request) {
        return privateResponse(sessions.current(request));
    }

    @PostMapping("/session")
    ResponseEntity<WebGuestSessions.Session> open(HttpServletRequest request) {
        WebGuestSessions.Issued result = sessions.open(request);
        var response = ResponseEntity.ok().cacheControl(CacheControl.noStore());
        if (result.cookie() != null) response.header(HttpHeaders.SET_COOKIE, result.cookie().toString());
        return response.body(result.session());
    }

    @DeleteMapping("/session")
    ResponseEntity<Void> revoke(HttpServletRequest request) {
        var cleared = sessions.revoke(request);
        var response = ResponseEntity.noContent().cacheControl(CacheControl.noStore());
        if (cleared != null) response.header(HttpHeaders.SET_COOKIE, cleared.toString());
        return response.build();
    }

    @PostMapping("/quotes")
    ResponseEntity<Quote> quote(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @RequestBody QuoteInput input) {
        return privateResponse(orders.createWebQuote(guest, input));
    }

    @PostMapping("/checkout-recovery")
    ResponseEntity<CheckoutRecovery> recoverCheckout(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest,
        @RequestBody CheckoutRecoveryInput input) {
        OrderAccessService.validatePhone(input.phone());
        OrderService.WebCheckoutLookup lookup = orders.lookupWebCheckout(input.quoteId(), input.key());
        if (lookup.orderId() != null) {
            UUID challenge = access.startCheckoutRecovery(guest, lookup.orderId(), input.phone()).challengeId();
            return privateResponse(new CheckoutRecovery("verify", null, challenge));
        }
        if (lookup.retryAt() != null) {
            return privateResponse(new CheckoutRecovery("waiting", lookup.retryAt(), null));
        }
        return privateResponse(new CheckoutRecovery("not_placed", null, null));
    }

    @PostMapping("/orders")
    ResponseEntity<WebOrder> order(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest,
        @RequestHeader(value = KEY, required = false) String key, @RequestBody OrderInput input) {
        Order order = orders.createWebOrder(guest, key, input);
        return privateResponse(WebOrder.from(order, false));
    }

    @GetMapping("/orders/recovery")
    ResponseEntity<WebOrder> recover(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest,
        @RequestHeader(value = KEY, required = false) String key) {
        return privateResponse(WebOrder.from(orders.recover(guest, key), false));
    }

    @GetMapping("/orders/{id}")
    ResponseEntity<WebOrder> order(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id) {
        return privateResponse(orders.getWebOrder(guest, orderId(id)));
    }

    @PostMapping("/orders/{id}/payments")
    ResponseEntity<PaymentAttempt> pay(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id,
        @RequestHeader(value = KEY, required = false) String key) {
        return privateResponse(orders.startPayment(guest, orderId(id), key));
    }

    @PostMapping("/orders/{id}/reorder")
    ResponseEntity<Reorder> reorder(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id) {
        return privateResponse(orders.reorder(guest, orderId(id)));
    }

    @GetMapping("/orders/{id}/receipt")
    ResponseEntity<byte[]> receipt(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id) {
        return receipts.downloadForGuest(guest, id);
    }

    @PostMapping("/order-access/challenges")
    ResponseEntity<OrderAccessService.ChallengeReceipt> startChallenge(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest,
        @RequestBody OrderAccessController.StartInput input) {
        return orderAccess.startForGuest(guest, input);
    }

    @PostMapping("/order-access/challenges/{id}/verify")
    CompletableFuture<ResponseEntity<OrderAccessService.VerifiedOrder>> verifyChallenge(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest,
        @PathVariable String id, @RequestBody OrderAccessController.VerifyInput input) {
        return orderAccess.verifyForGuest(guest, id, input);
    }

    private static UUID orderId(String id) {
        return ApiFailure.uuid(id, ApiFailure.notFound());
    }
}
