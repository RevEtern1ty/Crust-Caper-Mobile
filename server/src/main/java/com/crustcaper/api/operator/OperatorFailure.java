package com.crustcaper.api.operator;

import org.springframework.http.HttpStatus;

final class OperatorFailure extends RuntimeException {
    private final HttpStatus status;
    private final String code;

    OperatorFailure(HttpStatus status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }

    HttpStatus status() { return status; }

    String code() { return code; }

    static OperatorFailure invalid() {
        return new OperatorFailure(HttpStatus.BAD_REQUEST, "invalid_input");
    }

    static OperatorFailure unauthenticated() {
        return new OperatorFailure(HttpStatus.UNAUTHORIZED, "unauthenticated");
    }

    static OperatorFailure forbidden() {
        return new OperatorFailure(HttpStatus.FORBIDDEN, "forbidden");
    }

    static OperatorFailure notFound() {
        return new OperatorFailure(HttpStatus.NOT_FOUND, "not_found");
    }

    static OperatorFailure conflict(String code) {
        return new OperatorFailure(HttpStatus.CONFLICT, code);
    }

    static OperatorFailure rateLimited() {
        return new OperatorFailure(HttpStatus.TOO_MANY_REQUESTS, "rate_limited");
    }
}
