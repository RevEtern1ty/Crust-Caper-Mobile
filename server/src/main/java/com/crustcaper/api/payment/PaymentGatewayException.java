package com.crustcaper.api.payment;

public final class PaymentGatewayException extends RuntimeException {
    public enum Kind {
        INVALID_REQUEST, INVALID_RESPONSE, NOT_DISPATCHED, UNAVAILABLE
    }

    private final Kind kind;

    public PaymentGatewayException(Kind kind) {
        super(switch (kind) {
            case INVALID_REQUEST -> "Payment request does not match the provider contract";
            case INVALID_RESPONSE -> "Payment provider returned an invalid response";
            case NOT_DISPATCHED -> "Payment request could not be sent to the provider";
            case UNAVAILABLE -> "Payment provider could not complete this request";
        });
        this.kind = kind;
    }

    public Kind kind() {
        return kind;
    }
}
