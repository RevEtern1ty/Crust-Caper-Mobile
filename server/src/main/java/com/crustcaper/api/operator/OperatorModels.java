package com.crustcaper.api.operator;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

final class OperatorModels {
    private OperatorModels() { }

    record Login(String username, String password, String authenticatorCode) {
        Login(String username, String password) {
            this(username, password, null);
        }

        @Override
        public String toString() { return "Login[redacted]"; }
    }

    record Session(String accessToken, Instant expiresAt, String storeId, String role) {
        @Override
        public String toString() { return "Session[redacted]"; }
    }

    record StatusInput(String status, String pickupCode) {
        @Override
        public String toString() { return "StatusInput[redacted]"; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record OrderLine(String sku, List<String> modifierIds, int quantity) { }

    record OrderView(UUID id, String status, String paymentStatus, List<OrderLine> lines,
                     Instant pickupStartsAt, Instant pickupEndsAt,
                     @JsonInclude(JsonInclude.Include.ALWAYS) Instant acceptedAt) { }

    record Queue(List<OrderView> orders, Instant serverTime,
                 @JsonInclude(JsonInclude.Include.NON_EMPTY) List<OperatorExternalOrders.Order> externalOrders) { }

    record PickupStatus(UUID id, String status, boolean confirmedByCurrentOperator) { }

    record PaymentExceptionView(UUID orderId, UUID merchantReference, String providerTransactionId,
                                String reason, Instant createdAt,
                                @JsonInclude(JsonInclude.Include.NON_NULL) RefundView refund) { }

    record PaymentReview(List<PaymentExceptionView> exceptions) { }

    record PaymentReviewPage(List<PaymentExceptionView> exceptions,
                             @JsonInclude(JsonInclude.Include.ALWAYS) String nextCursor) { }

    record PendingPaymentAttempt(UUID orderId, UUID merchantReference, Instant reservationExpiresAt,
                                 @JsonInclude(JsonInclude.Include.ALWAYS) Instant lastCheckedAt) { }

    record PendingPaymentAttempts(List<PendingPaymentAttempt> attempts, boolean hasMore) { }

    record PaymentRecheck(String status) { }

    record RefundInput(String providerRefundId) { }

    record RefundView(String providerRefundId, String refundStatus, long amount, String currency, Instant recordedAt) { }
}
