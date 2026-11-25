package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.Problem;

import org.springframework.dao.DataAccessException;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
final class CommerceProblems {
    @ExceptionHandler(ApiFailure.class)
    ResponseEntity<Problem> problem(ApiFailure failure) {
        int status = failure.status();
        Problem body = new Problem("urn:crustcaper:problem:" + failure.code(),
            HttpStatus.valueOf(status).getReasonPhrase(), status, failure.code());
        var response = ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON)
            .cacheControl(CacheControl.noStore());
        if (status == 401) response.header(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        return response.body(body);
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, ServletRequestBindingException.class})
    ResponseEntity<Problem> badRequest() {
        return problem(ApiFailure.invalid());
    }

    @ExceptionHandler({DataAccessException.class, TransactionException.class, ArithmeticException.class})
    ResponseEntity<Problem> unavailable() {
        return problem(ApiFailure.unavailable());
    }
}
