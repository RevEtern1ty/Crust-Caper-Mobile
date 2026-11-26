package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.PaymentRecheck;
import com.crustcaper.api.operator.OperatorModels.PendingPaymentAttempts;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operator/payment-attempts")
final class OperatorPaymentAttemptsController {
    private final OperatorPaymentAttempts attempts;

    OperatorPaymentAttemptsController(OperatorPaymentAttempts attempts) {
        this.attempts = attempts;
    }

    @GetMapping("/pending")
    ResponseEntity<PendingPaymentAttempts> pending(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestParam(value = "after", required = false) String after) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(attempts.pending(authorization, after));
    }

    @PostMapping("/{merchantReference}/recheck")
    ResponseEntity<PaymentRecheck> recheck(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable String merchantReference) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(attempts.recheck(authorization, merchantReference));
    }
}
