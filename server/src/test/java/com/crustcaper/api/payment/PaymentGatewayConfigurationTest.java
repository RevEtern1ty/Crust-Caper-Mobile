package com.crustcaper.api.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import tools.jackson.databind.ObjectMapper;

class PaymentGatewayConfigurationTest {
    private static final String TEST_KEY = "FLWSECK_TEST-synthetic-context-test-v1";
    private static final String LIVE_KEY = "FLWSECK-synthetic-context-test-v1";
    private static final String PROFILE_ERROR = "Flutterwave requires an explicit stage or production profile without local";
    private static final String KEY_ERROR = "Flutterwave requires a test key on stage and a live key outside stage";
    private final ApplicationContextRunner configuration = new ApplicationContextRunner()
            .withUserConfiguration(PaymentGatewayConfiguration.class);

    @ParameterizedTest
    @ValueSource(strings = {"", "stgae", "local", "local,stage", "local,production", "stage,production", "stage,prod"})
    void refusesMissingOrConflictingActivePaymentProfiles(String profiles) {
        application(LIVE_KEY).withPropertyValues("spring.profiles.active=" + profiles).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseMessage(PROFILE_ERROR);
        });
    }

    @Test
    void springDefaultProductionDoesNotActivateLivePayments() {
        configuration.withBean(ObjectMapper.class, ObjectMapper::new)
                .withPropertyValues("crustcaper.payment.provider=flutterwave", "spring.profiles.active=",
                        "spring.profiles.default=production")
                .run(context -> {
                    assertThat(context).hasFailed();
                    assertThat(context.getStartupFailure()).hasRootCauseMessage(PROFILE_ERROR);
                });
    }

    @ParameterizedTest
    @ValueSource(strings = {"stage", "stage,metrics"})
    void explicitStageCreatesGatewayWithTestKey(String profiles) {
        application(TEST_KEY).withPropertyValues("spring.profiles.active=" + profiles)
                .run(context -> assertThat(context).hasSingleBean(FlutterwavePaymentGateway.class)
                        .hasSingleBean(FlutterwaveWebhookSignature.class));
    }

    @ParameterizedTest
    @ValueSource(strings = {"prod", "production", "production,metrics"})
    void explicitProductionCreatesGatewayWithLiveKey(String profiles) {
        application(LIVE_KEY).withPropertyValues("spring.profiles.active=" + profiles)
                .run(context -> assertThat(context).hasSingleBean(FlutterwavePaymentGateway.class)
                        .hasSingleBean(FlutterwaveWebhookSignature.class));
    }

    @Test
    void explicitEnvironmentsRejectTheOtherEnvironmentsKey() {
        application(LIVE_KEY).withPropertyValues("spring.profiles.active=stage").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseMessage(KEY_ERROR);
        });
        application(TEST_KEY).withPropertyValues("spring.profiles.active=production").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseMessage(KEY_ERROR);
        });
    }

    @Test
    void realProviderRequiresAnExplicitPaymentOption() {
        application(TEST_KEY).withPropertyValues("spring.profiles.active=stage", "crustcaper.payment.flutterwave.options=")
                .run(context -> {
                    assertThat(context).hasFailed();
                    assertThat(context.getStartupFailure()).rootCause()
                            .hasMessageContaining("CRUSTCAPER_FLUTTERWAVE_PAYMENT_OPTIONS");
                });
    }

    @Test
    void localProfileCanOpenCheckoutWithoutExposingAHostedUrl() {
        configuration.withPropertyValues("spring.profiles.active=local", "crustcaper.payment.provider=local")
                .run(context -> {
                    assertThat(context).hasSingleBean(PaymentGateway.class);
                    assertThat(context).doesNotHaveBean(FlutterwaveWebhookSignature.class);
                    PaymentGateway gateway = context.getBean(PaymentGateway.class);
                    PaymentGateway.PaymentRequest request = new PaymentGateway.PaymentRequest("attempt-1", "order-1",
                            9_200, "RWF", "+250700000000", null, Instant.parse("2026-11-25T19:00:00Z"));
                    assertThat(gateway.open(request).checkoutUrl()).isNull();
                    assertThat(gateway.verifyByReference(request.reference())).isEmpty();
                });
    }

    @ParameterizedTest
    @ValueSource(strings = {"stage", "local,stage", "local,prod", "local,production", "test"})
    void localProviderIsAbsentOutsideAnExclusiveLocalProfile(String profiles) {
        configuration.withPropertyValues("spring.profiles.active=" + profiles, "crustcaper.payment.provider=local")
                .run(context -> assertThat(context).doesNotHaveBean(PaymentGateway.class));
    }

    @Test
    void noProviderIsSelectedImplicitly() {
        configuration.withPropertyValues("spring.profiles.active=local")
                .run(context -> assertThat(context).doesNotHaveBean(PaymentGateway.class));
    }

    private ApplicationContextRunner application(String secretKey) {
        Map<String, String> variables = Map.of("FLUTTERWAVE_SECRET_KEY", secretKey,
                "FLUTTERWAVE_WEBHOOK_SECRET", "synthetic-context-webhook-only",
                "CRUST_PAYMENT_RETURN_URL", "https://checkout.example.test/payment-return");
        return new ApplicationContextRunner().withBean(ObjectMapper.class, ObjectMapper::new)
                .withBean(PaymentGatewayConfiguration.class, () -> new PaymentGatewayConfiguration(variables::get))
                .withPropertyValues("crustcaper.payment.provider=flutterwave", "crustcaper.payment.flutterwave.options=card");
    }
}
