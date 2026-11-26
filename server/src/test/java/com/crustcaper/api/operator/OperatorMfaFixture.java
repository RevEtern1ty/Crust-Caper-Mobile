package com.crustcaper.api.operator;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.UUID;
import org.springframework.test.context.DynamicPropertyRegistry;

public final class OperatorMfaFixture {
    static final String KEY = generateKey();

    private OperatorMfaFixture() { }

    public static byte[] encryptedSeed(UUID operator) {
        return new OperatorTotp(KEY).encryptSecret(operator, OperatorTotp.newSecret());
    }

    public static void registerKey(DynamicPropertyRegistry registry) {
        registry.add("crustcaper.operator.mfa-key", () -> KEY);
    }

    private static String generateKey() {
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        return Base64.getEncoder().encodeToString(key);
    }
}
