package com.crustcaper.api;

import java.util.UUID;

public final class ApiFailure extends RuntimeException {
    private final int status;
    private final String code;

    private ApiFailure(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    static ApiFailure invalid() {
        return new ApiFailure(400, "invalid_input");
    }

    static ApiFailure unauthenticated() {
        return new ApiFailure(401, "unauthenticated");
    }

    static ApiFailure forbidden() {
        return new ApiFailure(403, "forbidden");
    }

    static ApiFailure notFound() {
        return new ApiFailure(404, "not_found");
    }

    static ApiFailure conflict(String code) {
        return new ApiFailure(409, code);
    }

    static ApiFailure unavailable() {
        return new ApiFailure(503, "service_unavailable");
    }

    static UUID uuid(String value, ApiFailure failure) {
        if (value == null || value.length() != 36) throw failure;
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ignored) {
            throw failure;
        }
    }
}
