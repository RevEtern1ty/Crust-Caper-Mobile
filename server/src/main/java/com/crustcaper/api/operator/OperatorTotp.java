package com.crustcaper.api.operator;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class OperatorTotp {
    private static final byte FORMAT = 1;
    private static final int NONCE_BYTES = 12;
    private static final int SECRET_BYTES = 20;
    private static final int TAG_BYTES = 16;
    private static final int CIPHERTEXT_BYTES = 1 + NONCE_BYTES + SECRET_BYTES + TAG_BYTES;
    private static final int STEP_SECONDS = 30;
    private static final int CODE_MODULUS = 1_000_000;
    private static final byte[] PURPOSE = "crustcaper/operator-totp".getBytes(StandardCharsets.US_ASCII);
    private static final String HMAC = "HmacSHA1";
    private static final Pattern CODE = Pattern.compile("[0-9]{6}");
    private static final SecureRandom RANDOM = new SecureRandom();
    private final SecretKeySpec key;

    OperatorTotp(String configuredBase64Key) {
        if (configuredBase64Key == null || configuredBase64Key.length() != 44) throw invalidKey();
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(configuredBase64Key);
        } catch (IllegalArgumentException ignored) {
            throw invalidKey();
        }
        try {
            if (raw.length != 32 || !Base64.getEncoder().encodeToString(raw).equals(configuredBase64Key)) {
                throw invalidKey();
            }
            key = new SecretKeySpec(raw, "AES");
        } finally {
            Arrays.fill(raw, (byte) 0);
        }
    }

    static byte[] newSecret() {
        byte[] secret = new byte[SECRET_BYTES];
        RANDOM.nextBytes(secret);
        return secret;
    }

    byte[] encryptSecret(UUID account, byte[] secret) {
        if (secret == null || secret.length != SECRET_BYTES) throw new IllegalArgumentException("Invalid operator MFA seed");
        byte[] nonce = new byte[NONCE_BYTES];
        RANDOM.nextBytes(nonce);
        try {
            byte[] encrypted = cipher(Cipher.ENCRYPT_MODE, account, new GCMParameterSpec(TAG_BYTES * Byte.SIZE, nonce))
                .doFinal(secret);
            return ByteBuffer.allocate(CIPHERTEXT_BYTES).put(FORMAT).put(nonce).put(encrypted).array();
        } catch (GeneralSecurityException ignored) {
            throw new IllegalStateException("Operator MFA credential could not be encrypted");
        }
    }

    long matchingCounter(UUID account, byte[] encryptedSecret, String code, long unixSeconds) {
        if (code == null || !CODE.matcher(code).matches() || unixSeconds < 0) return -1;
        byte[] secret = decryptSecret(account, encryptedSecret);
        byte[] provided = code.getBytes(StandardCharsets.US_ASCII);
        byte[] expected = new byte[provided.length];
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(secret, HMAC));
            long counter = unixSeconds / STEP_SECONDS;
            long matched = -1;
            // Check the full window and retain the newest match so an older collision cannot bypass replay checks.
            for (long candidate = Math.max(0, counter - 1); candidate <= counter + 1; candidate++) {
                writeCode(mac, candidate, expected);
                if (MessageDigest.isEqual(provided, expected)) matched = candidate;
            }
            return matched;
        } catch (GeneralSecurityException ignored) {
            throw new IllegalStateException("Operator MFA verification failed");
        } finally {
            Arrays.fill(secret, (byte) 0);
            Arrays.fill(provided, (byte) 0);
            Arrays.fill(expected, (byte) 0);
        }
    }

    private byte[] decryptSecret(UUID account, byte[] encryptedSecret) {
        if (encryptedSecret == null || encryptedSecret.length != CIPHERTEXT_BYTES || encryptedSecret[0] != FORMAT) {
            throw unreadableCredential();
        }
        try {
            var parameters = new GCMParameterSpec(TAG_BYTES * Byte.SIZE, encryptedSecret, 1, NONCE_BYTES);
            return cipher(Cipher.DECRYPT_MODE, account, parameters)
                .doFinal(encryptedSecret, 1 + NONCE_BYTES, SECRET_BYTES + TAG_BYTES);
        } catch (GeneralSecurityException ignored) {
            throw unreadableCredential();
        }
    }

    private Cipher cipher(int operation, UUID account, GCMParameterSpec parameters) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(operation, key, parameters);
        byte[] scope = ByteBuffer.allocate(PURPOSE.length + 1 + 2 * Long.BYTES)
            .put(PURPOSE).put(FORMAT).putLong(account.getMostSignificantBits()).putLong(account.getLeastSignificantBits()).array();
        cipher.updateAAD(scope);
        return cipher;
    }

    // RFC 6238 uses the RFC 4226 dynamic truncation on the HMAC of an eight-byte moving counter.
    private static void writeCode(Mac mac, long counter, byte[] result) {
        byte[] signed = mac.doFinal(ByteBuffer.allocate(Long.BYTES).putLong(counter).array());
        int offset = signed[signed.length - 1] & 0x0f;
        int digits = (ByteBuffer.wrap(signed, offset, Integer.BYTES).getInt() & Integer.MAX_VALUE) % CODE_MODULUS;
        for (int index = result.length - 1; index >= 0; index--) {
            result[index] = (byte) ('0' + digits % 10);
            digits /= 10;
        }
        Arrays.fill(signed, (byte) 0);
    }

    private static IllegalStateException invalidKey() {
        return new IllegalStateException("CRUSTCAPER_OPERATOR_MFA_KEY must be canonical Base64 for a 32-byte key");
    }

    private static IllegalStateException unreadableCredential() {
        return new IllegalStateException("Operator MFA credential could not be read");
    }
}
