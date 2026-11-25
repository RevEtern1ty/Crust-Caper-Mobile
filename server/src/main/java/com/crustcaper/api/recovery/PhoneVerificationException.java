package com.crustcaper.api.recovery;

public final class PhoneVerificationException extends RuntimeException {
    private final Kind kind;

    public PhoneVerificationException(Kind kind) {
        super("Phone verification transport failed");
        this.kind = kind;
    }

    public Kind kind() {
        return kind;
    }

    public enum Kind {
        RETRY_LATER, UNAVAILABLE
    }
}
