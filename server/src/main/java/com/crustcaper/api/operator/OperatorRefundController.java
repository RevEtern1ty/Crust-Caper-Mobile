package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.RefundInput;
import com.crustcaper.api.operator.OperatorModels.RefundView;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class OperatorRefundController {
    private final OperatorRefunds refunds;

    OperatorRefundController(OperatorRefunds refunds) {
        this.refunds = refunds;
    }

    @PostMapping("/api/v1/operator/payment-exceptions/{merchantReference}/{providerTransactionId}/refund")
    ResponseEntity<RefundView> record(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
                                      @PathVariable String merchantReference, @PathVariable String providerTransactionId,
                                      @RequestBody RefundInput input) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(refunds.record(authorization, merchantReference, providerTransactionId, input.providerRefundId()));
    }
}
