package com.crustcaper.api.operator;

import com.crustcaper.api.ApiModels.Problem;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice(assignableTypes = {
        OperatorController.class, OperatorRefundController.class, OperatorPaymentAttemptsController.class,
        OperatorReconciliationController.class, OperatorExternalOrderController.class, OperatorOperationsController.class
})
final class OperatorProblems {
    @ExceptionHandler(OperatorFailure.class)
    ResponseEntity<Problem> problem(OperatorFailure failure) {
        HttpStatus status = failure.status();
        String code = failure.code();
        var response = ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .cacheControl(CacheControl.noStore());
        if (status == HttpStatus.UNAUTHORIZED) {
            response.header(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        }
        if (status == HttpStatus.TOO_MANY_REQUESTS) {
            response.header(HttpHeaders.RETRY_AFTER, "120");
        }
        return response.body(new Problem("urn:crustcaper:problem:" + code, status.getReasonPhrase(), status.value(), code));
    }
}
