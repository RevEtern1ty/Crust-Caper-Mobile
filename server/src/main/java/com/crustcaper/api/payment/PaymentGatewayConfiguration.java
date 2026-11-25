package com.crustcaper.api.payment;

import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Clock;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;

@Configuration(proxyBeanMethods = false)
class PaymentGatewayConfiguration {
    @Bean
    @ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "flutterwave")
    PaymentGateway flutterwaveGateway(ObjectMapper mapper, Environment environment) {
        String secret = System.getenv("FLUTTERWAVE_SECRET_KEY");
        boolean stage = environment.acceptsProfiles(Profiles.of("stage"));
        if (stage && environment.acceptsProfiles(Profiles.of("prod", "production"))) {
            throw new IllegalStateException("Flutterwave stage and production profiles cannot be active together");
        }
        String requiredPrefix = stage ? "FLWSECK_TEST-" : "FLWSECK-";
        if (secret != null && (!secret.startsWith(requiredPrefix) || secret.length() == requiredPrefix.length())) {
            throw new IllegalStateException("Flutterwave requires a test key on stage and a live key outside stage");
        }
        return new FlutterwavePaymentGateway(FlutterwavePaymentGateway.API_ORIGIN, configuredReturnUrl(), secret,
                mapper, Clock.systemUTC(), 4_000, 8_000);
    }

    @Bean
    @ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "flutterwave")
    FlutterwaveWebhookSignature flutterwaveWebhookSignature() {
        return new FlutterwaveWebhookSignature(System.getenv("FLUTTERWAVE_WEBHOOK_SECRET"));
    }

    @Bean
    @Profile("local & !stage & !prod & !production")
    @ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "local")
    PaymentGateway localGateway() {
        return new PaymentGateway() {
            @Override
            public HostedPayment open(PaymentRequest request) {
                return new HostedPayment(null);
            }

            @Override
            public VerifiedPayment verify(String transactionId) {
                throw new PaymentGatewayException(PaymentGatewayException.Kind.UNAVAILABLE);
            }

            @Override
            public Optional<VerifiedPayment> verifyByReference(String reference) {
                return Optional.empty();
            }
        };
    }

    private static URI configuredReturnUrl() {
        String value = System.getenv("CRUST_PAYMENT_RETURN_URL");
        try {
            if (value != null) {
                return URI.create(value);
            }
        } catch (IllegalArgumentException ignored) {
            // Avoid exposing a misconfigured URL in startup logs.
        }
        throw new IllegalStateException("CRUST_PAYMENT_RETURN_URL must be an absolute HTTPS URL");
    }
}
