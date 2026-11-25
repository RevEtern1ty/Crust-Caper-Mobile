package com.crustcaper.api.push;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "crustcaper.push.provider", havingValue = "expo")
public final class PickupPushCipher {
    private static final int NONCE_LENGTH = 12;
    private static final int TAG_BITS = 128;
    private static final byte FORMAT = 1;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TOKEN = Pattern.compile("(?:ExponentPushToken|ExpoPushToken)\\[[A-Za-z0-9_-]{1,128}\\]");
    private final SecretKeySpec key;

    public PickupPushCipher(@Value("${crustcaper.push.token-key:}") String configuredKey) {
        byte[] raw;
        try {
            if (configuredKey.length() < 43 || configuredKey.length() > 44) throw new IllegalArgumentException();
            raw = Base64.getDecoder().decode(configuredKey);
        } catch (IllegalArgumentException ignored) {
            throw new IllegalStateException("CRUSTCAPER_PUSH_TOKEN_KEY must encode a 32-byte key");
        }
        try {
            if (raw.length != 32) throw new IllegalStateException("CRUSTCAPER_PUSH_TOKEN_KEY must encode a 32-byte key");
            this.key = new SecretKeySpec(raw, "AES");
        } finally {
            Arrays.fill(raw, (byte) 0);
        }
    }

    public byte[] encrypt(UUID order, UUID guest, UUID installation, String token) {
        byte[] nonce = new byte[NONCE_LENGTH];
        RANDOM.nextBytes(nonce);
        byte[] plaintext = token.getBytes(StandardCharsets.US_ASCII);
        try {
            byte[] encrypted = cipher(Cipher.ENCRYPT_MODE, order, guest, installation, nonce).doFinal(plaintext);
            return ByteBuffer.allocate(1 + nonce.length + encrypted.length).put(FORMAT).put(nonce).put(encrypted).array();
        } catch (GeneralSecurityException ignored) {
            throw new IllegalStateException("Pickup push token encryption failed");
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    public static boolean validToken(String token) {
        return token != null && TOKEN.matcher(token).matches();
    }

    public String decrypt(UUID order, UUID guest, UUID installation, byte[] encryptedToken) {
        if (encryptedToken == null || encryptedToken.length < 30 || encryptedToken.length > 512 || encryptedToken[0] != FORMAT) {
            throw new IllegalStateException("Pickup push token has an invalid format");
        }
        byte[] nonce = Arrays.copyOfRange(encryptedToken, 1, 1 + NONCE_LENGTH);
        try {
            byte[] plaintext = cipher(Cipher.DECRYPT_MODE, order, guest, installation, nonce)
                .doFinal(encryptedToken, 1 + NONCE_LENGTH, encryptedToken.length - 1 - NONCE_LENGTH);
            try {
                return new String(plaintext, StandardCharsets.US_ASCII);
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        } catch (GeneralSecurityException ignored) {
            throw new IllegalStateException("Pickup push token decryption failed");
        }
    }

    private Cipher cipher(int operation, UUID order, UUID guest, UUID installation, byte[] nonce)
        throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(operation, key, new GCMParameterSpec(TAG_BITS, nonce));
        ByteBuffer scope = ByteBuffer.allocate(49).put(FORMAT);
        for (UUID value : new UUID[] { order, guest, installation }) {
            scope.putLong(value.getMostSignificantBits()).putLong(value.getLeastSignificantBits());
        }
        cipher.updateAAD(scope.array());
        return cipher;
    }
}
