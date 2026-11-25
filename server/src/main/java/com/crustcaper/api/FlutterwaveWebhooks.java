package com.crustcaper.api;

import com.crustcaper.api.payment.FlutterwaveWebhookSignature;
import com.crustcaper.api.payment.PaymentGateway;
import com.crustcaper.api.payment.PaymentGatewayException;
import tools.jackson.databind.JsonNode;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "flutterwave")
final class FlutterwaveWebhooks {
    private final FlutterwaveWebhookSignature signature;
    private final PaymentGateway gateway;
    private final OrderService orders;

    FlutterwaveWebhooks(FlutterwaveWebhookSignature signature, PaymentGateway gateway, OrderService orders) {
        this.signature = signature;
        this.gateway = gateway;
        this.orders = orders;
    }

    @PostMapping("/api/v1/webhooks/flutterwave")
    ResponseEntity<Void> receive(@RequestHeader(value = "verif-hash", required = false) String hash,
        @RequestBody JsonNode event) {
        if (!signature.matches(hash)) throw ApiFailure.unauthenticated();
        if (!event.path("event").asString("").equals("charge.completed")) return ResponseEntity.ok().build();
        String transaction = event.path("data").path("id").asString("");
        if (!transaction.matches("[1-9][0-9]{0,18}")) throw ApiFailure.invalid();
        try {
            orders.settlePayment(gateway.verify(transaction));
        } catch (PaymentGatewayException ignored) {
            throw ApiFailure.unavailable();
        }
        return ResponseEntity.ok().build();
    }
}
