package com.crustcaper.api.push;

import java.time.Instant;
import java.util.UUID;
import java.util.regex.Pattern;

interface ExpoPushTransport {
    String PICKUP_READY = "pickup-ready";
    Pattern TICKET_ID = Pattern.compile("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");

    SendResult send(ReadyAlert alert);

    ReceiptStatus receipt(String ticketId);

    record ReadyAlert(String token, UUID orderId, String locale, Instant expiresAt) {
        @Override public String toString() { return "ReadyAlert[redacted]"; }
    }

    record SendResult(SendStatus status, String ticketId) {
        static SendResult of(SendStatus status) { return new SendResult(status, null); }
    }

    enum SendStatus {
        ACCEPTED, THROTTLED, INVALID_TOKEN, REJECTED, AMBIGUOUS
    }

    enum ReceiptStatus {
        HANDED_OFF, PENDING, INVALID_TOKEN, REJECTED, UNAVAILABLE
    }
}
