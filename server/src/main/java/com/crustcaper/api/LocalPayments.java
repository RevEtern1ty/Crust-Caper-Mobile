package com.crustcaper.api;

import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Profile("local & !stage & !prod & !production")
@ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "local")
final class LocalPayments {
    private final GuestSessions sessions;
    private final OrderService orders;

    LocalPayments(GuestSessions sessions, OrderService orders) {
        this.sessions = sessions;
        this.orders = orders;
    }

    record LocalResult(String status) {}

    @PostMapping("/api/v1/local/orders/{id}/payments/{attemptId}/result")
    ResponseEntity<ApiModels.Order> resolve(
        @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id, @PathVariable String attemptId, @RequestBody LocalResult input) {
        UUID guest = sessions.authenticate(bearer);
        UUID order = ApiFailure.uuid(id, ApiFailure.notFound());
        UUID attempt = ApiFailure.uuid(attemptId, ApiFailure.notFound());
        PaymentResult result = switch (input.status() == null ? "" : input.status()) {
            case "paid" -> PaymentResult.PAID;
            case "declined" -> PaymentResult.DECLINED;
            default -> throw ApiFailure.invalid();
        };
        orders.setLocalPayment(guest, order, attempt, result);
        return CommerceController.privateResponse(orders.getOrder(guest, order));
    }
}
