package com.crustcaper.api;

import static com.crustcaper.api.CommerceController.privateResponse;
import static com.crustcaper.api.WebCommerceAccess.GUEST_ATTRIBUTE;

import com.crustcaper.api.payment.PaymentGateway.CheckoutChannel;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
final class CheckoutRecoveryController {
    record Input(String quoteId, String key, String phone) {
        @Override
        public String toString() { return "CheckoutRecoveryInput[redacted]"; }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Recovery(String state, Instant retryAt, UUID challengeId) {}

    private final GuestSessions sessions;
    private final OrderService orders;
    private final OrderAccessService access;

    CheckoutRecoveryController(GuestSessions sessions, OrderService orders, OrderAccessService access) {
        this.sessions = sessions;
        this.orders = orders;
        this.access = access;
    }

    @PostMapping("/checkout-recovery")
    ResponseEntity<Recovery> recoverMobile(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestBody Input input) {
        return recover(sessions.authenticate(bearer), input, CheckoutChannel.MOBILE);
    }

    @PostMapping("/web/checkout-recovery")
    ResponseEntity<Recovery> recoverWeb(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @RequestBody Input input) {
        return recover(guest, input, CheckoutChannel.WEB);
    }

    private ResponseEntity<Recovery> recover(UUID guest, Input input, CheckoutChannel channel) {
        OrderAccessService.validatePhone(input.phone());
        var lookup = orders.lookupCheckout(input.quoteId(), input.key(), channel);
        if (lookup.orderId() != null) {
            UUID challenge = access.startCheckoutRecovery(guest, lookup.orderId(), input.phone(), channel).challengeId();
            return privateResponse(new Recovery("verify", null, challenge));
        }
        if (lookup.retryAt() != null) return privateResponse(new Recovery("waiting", lookup.retryAt(), null));
        return privateResponse(new Recovery("not_placed", null, null));
    }
}
