package com.crustcaper.api.recovery;

import static com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck.APPROVED;
import static com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck.EXPIRED;
import static com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck.INVALID;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.env.SystemEnvironmentPropertySource;
import tools.jackson.databind.ObjectMapper;

class PhoneVerificationConfigurationTest {
    private final ApplicationContextRunner application = new ApplicationContextRunner()
            .withBean(ObjectMapper.class, () -> new ObjectMapper())
            .withUserConfiguration(PhoneVerificationConfiguration.class);

    @Test
    void defaultStageHasNoTransportEvenWhenTwilioSecretsArePresent() {
        withEnv(Map.of("SPRING_PROFILES_ACTIVE", "stage",
                "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SECRET", "fixture-only-not-a-twilio-credential"))
                .run(context -> assertThat(context).doesNotHaveBean(PhoneVerificationGateway.class));
    }

    @Test
    void usesDeploymentEnvironmentNamesForTwilio() {
        withEnv(Map.of("SPRING_PROFILES_ACTIVE", "stage", "CRUSTCAPER_ORDER_ACCESS_PROVIDER", "twilio",
                "CRUSTCAPER_TWILIO_VERIFY_SERVICE_SID", "VA" + "1".repeat(32),
                "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SID", "SK" + "2".repeat(32),
                "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SECRET", "fixture-only-not-a-twilio-credential"))
                .run(context -> {
                    assertThat(context).hasSingleBean(PhoneVerificationGateway.class);
                    assertThat(context.getBean(PhoneVerificationGateway.class)).isInstanceOf(TwilioPhoneVerificationGateway.class);
                });
    }

    @Test
    void enabledTwilioFailsStartupWithoutCredentials() {
        withEnv(Map.of("SPRING_PROFILES_ACTIVE", "stage", "CRUSTCAPER_ORDER_ACCESS_PROVIDER", "twilio"))
                .run(context -> {
                    assertThat(context).hasFailed();
                    assertThat(context.getStartupFailure()).hasRootCauseMessage("Set a valid CRUSTCAPER_TWILIO_VERIFY_SERVICE_SID");
                });
    }

    @Test
    void twilioCannotSendFromTheLocalProfileEvenWithValidCredentials() {
        withEnv(Map.of("SPRING_PROFILES_ACTIVE", "local", "CRUSTCAPER_ORDER_ACCESS_PROVIDER", "twilio",
                "CRUSTCAPER_TWILIO_VERIFY_SERVICE_SID", "VA" + "1".repeat(32),
                "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SID", "SK" + "2".repeat(32),
                "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SECRET", "fixture-only-not-a-twilio-credential"))
                .run(context -> assertThat(context).hasFailed());
    }

    @ParameterizedTest
    @ValueSource(strings = {"stage", "production", "local,stage", "local,prod", "local,production", "test"})
    void syntheticTransportFailsStartupOutsideLocal(String profiles) {
        withEnv(Map.of("SPRING_PROFILES_ACTIVE", profiles, "CRUSTCAPER_ORDER_ACCESS_PROVIDER", "local"))
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void onlyTheLocalFixtureCanUseTheSyntheticTransportAndItsSidIsSingleUse() {
        withEnv(Map.of("SPRING_PROFILES_ACTIVE", "local", "CRUSTCAPER_ORDER_ACCESS_PROVIDER", "local"))
                .run(context -> {
                    assertThat(context).hasSingleBean(PhoneVerificationGateway.class);
                    PhoneVerificationGateway gateway = context.getBean(PhoneVerificationGateway.class);
                    assertThrows(PhoneVerificationException.class, () -> gateway.send("+250700000001"));
                    String sid = gateway.send(LocalPhoneVerificationGateway.FIXTURE_PHONE);
                    assertThat(sid).matches("VE[0-9a-f]{32}");
                    assertThat(gateway.check("VE" + "7".repeat(32), LocalPhoneVerificationGateway.FIXTURE_CODE)).isEqualTo(EXPIRED);
                    assertThat(gateway.check(sid, "019000")).isEqualTo(INVALID);
                    assertThat(gateway.check(sid, LocalPhoneVerificationGateway.FIXTURE_CODE)).isEqualTo(APPROVED);
                    assertThat(gateway.check(sid, LocalPhoneVerificationGateway.FIXTURE_CODE)).isEqualTo(EXPIRED);
                });
    }

    private ApplicationContextRunner withEnv(Map<String, Object> environment) {
        return application.withInitializer(context -> context.getEnvironment().getPropertySources()
                .addFirst(new SystemEnvironmentPropertySource("fixture environment", environment)));
    }
}
