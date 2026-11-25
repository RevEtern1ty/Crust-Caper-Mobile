package com.crustcaper.api.payment;

import java.time.Instant;
import java.util.Optional;

public interface PaymentGateway {
    long MAX_CHARGE_RWF = Integer.MAX_VALUE;

    HostedPayment open(PaymentRequest request);

    VerifiedPayment verify(String transactionId);

    Optional<VerifiedPayment> verifyByReference(String reference);

    record PaymentRequest(String reference, String orderId, long amount, String currency,
                          String phone, String email, Instant expiresAt) {
        @Override
        public String toString() {
            return "PaymentRequest[redacted]";
        }
    }

    record HostedPayment(String checkoutUrl) {
        @Override
        public String toString() {
            return "HostedPayment[redacted]";
        }
    }

    record VerifiedPayment(String reference, String transactionId, long amount, String currency,
                           PaymentResult result) { }

    enum PaymentResult {
        PROCESSING, PAID, DECLINED
    }
}
