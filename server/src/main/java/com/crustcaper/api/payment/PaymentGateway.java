package com.crustcaper.api.payment;

import java.time.Instant;
import java.util.Optional;

public interface PaymentGateway {
    long MAX_CHARGE_RWF = Integer.MAX_VALUE;

    /** INVALID_REQUEST is reserved for a checkout rejected before any provider request is sent. */
    HostedPayment open(PaymentRequest request);

    VerifiedPayment verify(String transactionId);

    Optional<VerifiedPayment> verifyByReference(String reference);

    static boolean supportsCustomerEmail(String email) {
        return email != null && email.length() <= 254
            && email.matches("[^@\\s\\p{Cntrl}]+@[^@\\s\\p{Cntrl}]+\\.[^@\\s\\p{Cntrl}]+");
    }

    record PaymentRequest(String reference, String orderId, long amount, String currency,
                          String phone, String email, Instant expiresAt, CheckoutChannel checkoutChannel) {
        PaymentRequest(String reference, String orderId, long amount, String currency,
                       String phone, String email, Instant expiresAt) {
            this(reference, orderId, amount, currency, phone, email, expiresAt, CheckoutChannel.MOBILE);
        }

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

    enum CheckoutChannel {
        MOBILE, WEB
    }
}
