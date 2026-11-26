package com.crustcaper.api.operator;

import java.io.Console;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;

public final class OperatorTotpEnrollment {
    private static final String BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    private OperatorTotpEnrollment() { }

    public static void main(String[] args) {
        Console terminal = System.console();
        if (args.length != 0 || terminal == null) {
            throw new IllegalArgumentException("Run the operator enrollment tool in an interactive terminal without arguments");
        }
        var totp = new OperatorTotp(System.getenv("CRUSTCAPER_OPERATOR_MFA_KEY"));
        String store = terminal.readLine("Store ID: ");
        String accountId = terminal.readLine("Operator account UUID: ");
        String username = terminal.readLine("Operator username: ");
        if (store == null || accountId == null || username == null) return;
        if (!store.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}") || !username.matches("[a-z0-9][a-z0-9._-]{2,63}")
                || username.startsWith("demo-")) {
            throw new IllegalArgumentException("Enter a valid store ID and a named operator username");
        }
        UUID account = UUID.fromString(accountId);
        if (!account.toString().equals(accountId)) {
            throw new IllegalArgumentException("Enter the canonical lowercase operator account UUID");
        }

        byte[] secret = OperatorTotp.newSecret();
        char[] setupKey = base32(secret);
        byte[] encrypted;
        try {
            encrypted = totp.encryptSecret(account, secret);
            terminal.printf("Set up a time-based authenticator account with SHA-1, 6 digits and a 30-second period.%n");
            terminal.printf("Setup key: ");
            terminal.writer().println(setupKey);
            terminal.flush();
        } finally {
            Arrays.fill(secret, (byte) 0);
            Arrays.fill(setupKey, '\0');
        }

        for (int attempt = 0; attempt < 3; attempt++) {
            char[] code = terminal.readPassword("Current authenticator code: ");
            if (code == null) return;
            try {
                if (totp.matchingCounter(account, encrypted, new String(code), Instant.now().getEpochSecond()) >= 0) {
                    String payload = "{\"operation\":\"enroll-mfa\",\"storeId\":\"%s\",\"accountId\":\"%s\","
                        + "\"username\":\"%s\",\"encryptedSecret\":\"%s\"}";
                    byte[] json = payload.formatted(store, account, username, Base64.getEncoder().encodeToString(encrypted))
                        .getBytes(StandardCharsets.UTF_8);
                    terminal.printf("Submit this encrypted request to operator-accounts.psql on standard input:%n%s%n",
                        Base64.getEncoder().encodeToString(json));
                    return;
                }
            } finally {
                Arrays.fill(code, '\0');
            }
            terminal.printf("Code did not match. Enter a current code from the newly added account.%n");
        }
        terminal.printf("Enrollment was not generated.%n");
    }

    private static char[] base32(byte[] secret) {
        char[] encoded = new char[secret.length * Byte.SIZE / 5];
        int buffer = 0;
        int bits = 0;
        int index = 0;
        for (byte element : secret) {
            buffer = (buffer << Byte.SIZE) | (element & 0xff);
            bits += Byte.SIZE;
            while (bits >= 5) {
                bits -= 5;
                encoded[index++] = BASE32_ALPHABET.charAt((buffer >>> bits) & 0x1f);
            }
        }
        return encoded;
    }
}
