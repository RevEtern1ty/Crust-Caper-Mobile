package com.crustcaper.api.payment;

import com.crustcaper.api.WebOrigin;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;

@Configuration(proxyBeanMethods = false)
class PaymentGatewayConfiguration {
    private final Function<String, String> deploymentVariable;

    PaymentGatewayConfiguration() {
        this(System::getenv);
    }

    PaymentGatewayConfiguration(Function<String, String> deploymentVariable) {
        this.deploymentVariable = deploymentVariable;
    }

    @Bean
    @ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "flutterwave")
    FlutterwavePaymentGateway flutterwaveGateway(ObjectMapper mapper, Environment environment) {
        List<String> active = List.of(environment.getActiveProfiles());
        boolean stage = active.contains("stage");
        boolean production = active.contains("prod") || active.contains("production");
        if (stage == production || active.contains("local") || active.contains("demo") || active.contains("test")) {
            throw new IllegalStateException("SPRING_PROFILES_ACTIVE must select Flutterwave stage or production "
                    + "without local, demo or test profiles");
        }
        String secret = deploymentVariable.apply("FLUTTERWAVE_SECRET_KEY");
        String requiredPrefix = stage ? "FLWSECK_TEST-" : "FLWSECK-";
        if (secret != null && (!secret.startsWith(requiredPrefix) || secret.length() == requiredPrefix.length())) {
            throw new IllegalStateException("Flutterwave requires a test key on stage and a live key on production");
        }
        return new FlutterwavePaymentGateway(FlutterwavePaymentGateway.API_ORIGIN, configuredReturnUrl(),
                configuredWebReturnUrl(environment), secret,
                environment.getProperty("crustcaper.payment.flutterwave.options"), mapper, Clock.systemUTC(), 4_000, 8_000);
    }

    @Bean
    @ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "flutterwave")
    FlutterwaveWebhookSignature flutterwaveWebhookSignature() {
        return new FlutterwaveWebhookSignature(deploymentVariable.apply("FLUTTERWAVE_WEBHOOK_SECRET"));
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

    private URI configuredReturnUrl() {
        String value = deploymentVariable.apply("CRUST_PAYMENT_RETURN_URL");
        try {
            if (value != null) {
                return URI.create(value);
            }
        } catch (IllegalArgumentException ignored) {
            // Avoid exposing a misconfigured URL in startup logs.
        }
        throw new IllegalStateException("CRUST_PAYMENT_RETURN_URL must be an absolute HTTPS URL");
    }

    private static URI configuredWebReturnUrl(Environment environment) {
        String origin = WebOrigin.parse(environment.getProperty("crustcaper.web.origin"));
        return origin == null ? null : URI.create(origin + FlutterwavePaymentGateway.WEB_PAYMENT_RETURN_PATH);
    }
}
