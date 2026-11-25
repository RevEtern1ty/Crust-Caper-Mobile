package com.crustcaper.api.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class PaymentGatewayConfigurationTest {
    private final ApplicationContextRunner configuration = new ApplicationContextRunner()
            .withUserConfiguration(PaymentGatewayConfiguration.class);

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
    @ValueSource(strings = { "stage", "local,stage", "local,prod", "local,production", "test" })
    void localProviderIsAbsentOutsideAnExclusiveLocalProfile(String profiles) {
        configuration.withPropertyValues("spring.profiles.active=" + profiles, "crustcaper.payment.provider=local")
                .run(context -> assertThat(context).doesNotHaveBean(PaymentGateway.class));
    }

    @Test
    void noProviderIsSelectedImplicitly() {
        configuration.withPropertyValues("spring.profiles.active=local")
                .run(context -> assertThat(context).doesNotHaveBean(PaymentGateway.class));
    }
}
