package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class OperatorTotpTest {
    private static final String FIXTURE_KEY = Base64.getEncoder().encodeToString(new byte[32]);
    private static final byte[] RFC_SEED = "12345678901234567890".getBytes(StandardCharsets.US_ASCII);
    private static final UUID ACCOUNT = UUID.fromString("123e4567-e89b-42d3-a456-426614174000");
    private static final UUID OTHER_ACCOUNT = UUID.fromString("123e4567-e89b-42d3-a456-426614174001");

    private final OperatorTotp totp = new OperatorTotp(FIXTURE_KEY);

    @ParameterizedTest
    @CsvSource({
        "59, 287082",
        "1111111109, 081804",
        "1111111111, 050471",
        "1234567890, 005924",
        "2000000000, 279037",
        "20000000000, 353130",
    })
    void matchesSixDigitSha1SuffixesOfRfc6238AppendixB(long unixSeconds, String code) {
        byte[] encrypted = totp.encryptSecret(ACCOUNT, RFC_SEED);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, code, unixSeconds)).isEqualTo(unixSeconds / 30);
    }

    @Test
    void acceptsOnlyTheAdjacentTimeStepsAndRequiresExactlySixAsciiDigits() {
        byte[] encrypted = totp.encryptSecret(ACCOUNT, RFC_SEED);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "287082", 0)).isEqualTo(1);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "287082", 89)).isEqualTo(1);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "287082", 90)).isEqualTo(-1);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "287082", -1)).isEqualTo(-1);
        for (String invalid : Arrays.asList(null, "", "28708", "0287082", " 287082", "２８７０８２", "28708\n")) {
            assertThat(totp.matchingCounter(ACCOUNT, encrypted, invalid, 59)).isEqualTo(-1);
        }
    }

    @Test
    void returnsTheHighestMatchingCounterWhenAdjacentCodesCollide() {
        byte[] encrypted = totp.encryptSecret(ACCOUNT, RFC_SEED);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "911617", 910736L * 30)).isEqualTo(910737);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "911617", 910737L * 30)).isEqualTo(910738);
        assertThat(totp.matchingCounter(ACCOUNT, encrypted, "911617", 910739L * 30)).isEqualTo(910738);
    }

    @Test
    void copiesOfTheSeedUseDifferentNoncesAndFramesCannotBeMovedOrTamperedWith() {
        byte[] first = totp.encryptSecret(ACCOUNT, RFC_SEED);
        byte[] second = totp.encryptSecret(ACCOUNT, RFC_SEED);
        assertThat(first).hasSize(49);
        assertThat(first[0]).isEqualTo((byte) 1);
        assertThat(Arrays.copyOfRange(first, 1, 13)).isNotEqualTo(Arrays.copyOfRange(second, 1, 13));
        assertThat(totp.matchingCounter(ACCOUNT, first, "287082", 59)).isEqualTo(1);
        assertThat(totp.matchingCounter(ACCOUNT, second, "287082", 59)).isEqualTo(1);
        assertThatThrownBy(() -> totp.matchingCounter(OTHER_ACCOUNT, first, "287082", 59))
            .isInstanceOf(IllegalStateException.class).hasMessage("Operator MFA credential could not be read");
        for (int index : new int[] { 0, 1, 13, 48 }) {
            byte[] damaged = first.clone();
            damaged[index] ^= 1;
            assertThatThrownBy(() -> totp.matchingCounter(ACCOUNT, damaged, "287082", 59))
                .isInstanceOf(IllegalStateException.class).hasMessage("Operator MFA credential could not be read");
        }
        assertThatThrownBy(() -> totp.matchingCounter(ACCOUNT, Arrays.copyOf(first, 48), "287082", 59))
            .isInstanceOf(IllegalStateException.class).hasMessage("Operator MFA credential could not be read");
    }

    @Test
    void requiresCanonicalStandardBase64AndUsesDifferentKeysForDifferentEnvironments() {
        String wrongLength = Base64.getEncoder().encodeToString(new byte[31]);
        String withoutPadding = FIXTURE_KEY.substring(0, 43);
        String noncanonical = FIXTURE_KEY.substring(0, 42) + "B=";
        for (String invalid : Arrays.asList(null, "", wrongLength, withoutPadding, noncanonical, " " + FIXTURE_KEY)) {
            assertThatThrownBy(() -> new OperatorTotp(invalid)).isInstanceOf(IllegalStateException.class)
                .hasMessage("CRUSTCAPER_OPERATOR_MFA_KEY must be canonical Base64 for a 32-byte key");
        }
        byte[] key = new byte[32];
        key[0] = 1;
        var otherEnvironment = new OperatorTotp(Base64.getEncoder().encodeToString(key));
        byte[] encrypted = totp.encryptSecret(ACCOUNT, RFC_SEED);
        assertThatThrownBy(() -> otherEnvironment.matchingCounter(ACCOUNT, encrypted, "287082", 59))
            .isInstanceOf(IllegalStateException.class).hasMessage("Operator MFA credential could not be read");
    }
}
