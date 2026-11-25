package com.crustcaper.api.payment;

import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

public interface RefundDirectory {
    Pattern PROVIDER_ID = Pattern.compile("[1-9][0-9]{0,18}");
    Set<String> FINAL_STATUSES = Set.of("completed-bank-transfer", "completed-momo", "completed-mpgs",
            "completed-offline", "completed-preauth");

    Optional<ConfirmedRefund> confirm(RefundRequest request);

    static boolean validId(String id) {
        return id != null && PROVIDER_ID.matcher(id).matches();
    }

    record RefundRequest(String refundId, String transactionId, long amount, String currency) { }

    record ConfirmedRefund(String refundId, String transactionId, long amount, String currency, String status) {
        public boolean confirms(RefundRequest request) {
            return request.refundId().equals(refundId) && request.transactionId().equals(transactionId)
                    && request.amount() == amount && request.currency().equals(currency)
                    && status != null && FINAL_STATUSES.contains(status);
        }
    }
}
