package com.crustcaper.api.operator;

import java.io.Console;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public final class OperatorPasswordHash {
    private static final int WORK_FACTOR = 600_000;
    private static final int SALT_BYTES = 16;
    private static final int HASH_BYTES = 32;
    private static final String ALGORITHM = "pbkdf2-sha256";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder ENCODE = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODE = Base64.getUrlDecoder();

    private OperatorPasswordHash() { }

    static String hash(char[] password) {
        if (password.length < 12 || password.length > 256) {
            throw new IllegalArgumentException("Operator passphrases must contain 12–256 characters");
        }
        byte[] salt = new byte[SALT_BYTES];
        RANDOM.nextBytes(salt);
        byte[] key = derive(password, salt);
        try {
            return "$" + ALGORITHM + "$" + WORK_FACTOR + "$" + ENCODE.encodeToString(salt) + "$" + ENCODE.encodeToString(key);
        } finally {
            Arrays.fill(key, (byte) 0);
        }
    }

    static boolean matches(char[] password, String encoded) {
        String[] parts = encoded.split("\\$", -1);
        if (parts.length != 5 || !parts[0].isEmpty() || !ALGORITHM.equals(parts[1])
                || !Integer.toString(WORK_FACTOR).equals(parts[2])) {
            return false;
        }
        try {
            byte[] salt = DECODE.decode(parts[3]);
            byte[] expected = DECODE.decode(parts[4]);
            if (salt.length != SALT_BYTES || expected.length != HASH_BYTES) {
                return false;
            }
            byte[] actual = derive(password, salt);
            try {
                return MessageDigest.isEqual(expected, actual);
            } finally {
                Arrays.fill(actual, (byte) 0);
                Arrays.fill(expected, (byte) 0);
            }
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static byte[] derive(char[] password, byte[] salt) {
        PBEKeySpec spec = new PBEKeySpec(password, salt, WORK_FACTOR, HASH_BYTES * Byte.SIZE);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("Operator password hashing is unavailable", error);
        } finally {
            spec.clearPassword();
        }
    }

    public static void main(String[] args) {
        Console terminal = System.console();
        if (args.length != 0 || terminal == null) {
            throw new IllegalArgumentException("Run the hash tool in an interactive terminal without arguments");
        }
        char[] password = terminal.readPassword("New operator passphrase: ");
        if (password == null) {
            return;
        }
        try {
            terminal.printf("%s%n", hash(password));
        } finally {
            Arrays.fill(password, '\0');
        }
    }
}
