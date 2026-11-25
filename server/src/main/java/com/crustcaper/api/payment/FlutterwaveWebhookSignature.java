package com.crustcaper.api.payment;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public final class FlutterwaveWebhookSignature {
    private final byte[] expected;

    FlutterwaveWebhookSignature(String secret) {
        if (secret == null || !secret.matches("[!-~]{24,256}")) {
            throw new IllegalStateException("FLUTTERWAVE_WEBHOOK_SECRET must be a random printable token of 24–256 characters");
        }
        expected = secret.getBytes(StandardCharsets.UTF_8);
    }

    public boolean matches(String header) {
        // Standard v3 supplies the merchant secret via verif-hash.
        return header != null && header.length() <= 256
                && MessageDigest.isEqual(expected, header.getBytes(StandardCharsets.UTF_8));
    }
}
