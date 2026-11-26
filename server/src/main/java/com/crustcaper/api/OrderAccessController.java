package com.crustcaper.api;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/order-access/challenges")
final class OrderAccessController {
    private final GuestSessions sessions;
    private final OrderAccessService access;
    private final Duration negativeDelay;

    record StartInput(String orderCode, String phone) {
        @Override
        public String toString() { return "OrderAccessStart[redacted]"; }
    }
    record VerifyInput(String code) {
        @Override
        public String toString() { return "OrderAccessVerification[redacted]"; }
    }

    OrderAccessController(GuestSessions sessions, OrderAccessService access,
        @Value("${crustcaper.order-access.negative-delay:PT12S}") Duration negativeDelay) {
        if (negativeDelay.isNegative() || negativeDelay.compareTo(Duration.ofSeconds(13)) > 0) {
            throw new IllegalArgumentException("Invalid order access negative response delay");
        }
        this.sessions = sessions;
        this.access = access;
        this.negativeDelay = negativeDelay;
    }

    @PostMapping
    ResponseEntity<OrderAccessService.ChallengeReceipt> start(
        @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestBody StartInput input) {
        return startForGuest(sessions.authenticate(bearer), input);
    }

    ResponseEntity<OrderAccessService.ChallengeReceipt> startForGuest(UUID guest, StartInput input) {
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore())
            .body(access.start(guest, input.orderCode(), input.phone()));
    }

    @PostMapping("/{id}/verify")
    CompletableFuture<ResponseEntity<OrderAccessService.VerifiedOrder>> verify(
        @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id, @RequestBody VerifyInput input) {
        return verifyForGuest(sessions.authenticate(bearer), id, input);
    }

    CompletableFuture<ResponseEntity<OrderAccessService.VerifiedOrder>> verifyForGuest(UUID guest, String id, VerifyInput input) {
        long started = System.nanoTime();
        try {
            UUID challenge = ApiFailure.uuid(id, ApiFailure.notFound());
            return CompletableFuture.completedFuture(CommerceController.privateResponse(access.verify(guest, challenge, input.code())));
        } catch (ApiFailure failure) {
            if (failure.status() != 404) throw failure;
            // Pad a negative result without holding a servlet thread while waiting.
            var response = new CompletableFuture<ResponseEntity<OrderAccessService.VerifiedOrder>>();
            long remaining = Math.max(0, negativeDelay.toNanos() - (System.nanoTime() - started));
            CompletableFuture.delayedExecutor(remaining, TimeUnit.NANOSECONDS)
                .execute(() -> response.completeExceptionally(failure));
            return response;
        }
    }
}
