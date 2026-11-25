package com.crustcaper.api.push;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

class PickupPushDeliveryConfigurationTest {
    private final ApplicationContextRunner application = new ApplicationContextRunner()
            .withBean(ObjectMapper.class, () -> new ObjectMapper())
            .withBean(JdbcClient.class, () -> mock(JdbcClient.class))
            .withBean(TransactionTemplate.class, () -> mock(TransactionTemplate.class))
            .withBean(MeterRegistry.class, SimpleMeterRegistry::new)
            .withUserConfiguration(PickupPushDeliveryConfiguration.class, PickupPushMaintenanceConfiguration.class,
                    PickupPushCipher.class);

    @Test
    void stageWithoutProviderRunsOnlyDatabaseMaintenance() {
        application.withPropertyValues("spring.profiles.active=stage").run(context -> {
            assertThat(context).hasSingleBean(PickupPushMaintenance.class);
            assertThat(context).doesNotHaveBean(PickupPushWorker.class);
            assertThat(context).doesNotHaveBean(ExpoPushTransport.class);
            assertThat(context).doesNotHaveBean(PickupPushCipher.class);
        });
    }

    @Test
    void localHasNeitherTransportNorScheduledMaintenance() {
        application.withPropertyValues("spring.profiles.active=local").run(context -> {
            assertThat(context).doesNotHaveBean(ExpoPushTransport.class);
            assertThat(context).doesNotHaveBean(PickupPushMaintenance.class);
        });
    }

    @ParameterizedTest
    @ValueSource(strings = {"stage", "production", "prod"})
    void configuredNonlocalProfileCreatesTransportWithoutCallingExpo(String profile) {
        enabled(profile).withPropertyValues("crustcaper.push.expo-access-token=fixture-only-not-an-expo-credential")
                .run(context -> {
                    assertThat(context).hasSingleBean(ExpoPushTransport.class);
                    assertThat(context).hasSingleBean(PickupPushWorker.class);
                    assertThat(context).hasSingleBean(PickupPushMaintenance.class);
                });
    }

    @ParameterizedTest
    @ValueSource(strings = {"local", "local,stage", "stage,production", "test"})
    void realProviderFailsForUnsupportedOrMixedProfiles(String profile) {
        enabled(profile).withPropertyValues("crustcaper.push.expo-access-token=fixture-only-not-an-expo-credential")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void enabledStageRequiresServerAccessToken() {
        enabled("stage").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseMessage("Set a valid CRUSTCAPER_EXPO_PUSH_ACCESS_TOKEN");
        });
    }

    private ApplicationContextRunner enabled(String profile) {
        return application.withPropertyValues("spring.profiles.active=" + profile, "crustcaper.push.provider=expo",
                "crustcaper.push.token-key=" + Base64.getEncoder().encodeToString(new byte[32]));
    }
}
