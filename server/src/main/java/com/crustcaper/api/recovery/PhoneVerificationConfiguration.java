package com.crustcaper.api.recovery;

import java.time.Clock;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import tools.jackson.databind.ObjectMapper;

@Configuration(proxyBeanMethods = false)
class PhoneVerificationConfiguration {
    private static final String PROVIDER = "crustcaper.order-access.provider";

    PhoneVerificationConfiguration(Environment environment) {
        String provider = environment.getProperty(PROVIDER, "disabled");
        if (!Set.of("disabled", "local", "twilio").contains(provider)) {
            throw new IllegalStateException("Set CRUSTCAPER_ORDER_ACCESS_PROVIDER to disabled, local or twilio");
        }
        if (provider.equals("local") && !environment.acceptsProfiles(Profiles.of("local & !stage & !prod & !production"))) {
            throw new IllegalStateException("Local phone verification requires a local Spring profile without stage or production");
        }
        if (provider.equals("twilio") && environment.acceptsProfiles(Profiles.of("local"))) {
            throw new IllegalStateException("Twilio phone verification cannot be enabled with the local Spring profile");
        }
    }

    @Bean
    @Profile("!local")
    @ConditionalOnProperty(name = PROVIDER, havingValue = "twilio")
    PhoneVerificationGateway twilioPhoneVerification(ObjectMapper mapper, Environment environment) {
        return new TwilioPhoneVerificationGateway(mapper,
                environment.getProperty("CRUSTCAPER_TWILIO_VERIFY_SERVICE_SID"),
                environment.getProperty("CRUSTCAPER_TWILIO_VERIFY_API_KEY_SID"),
                environment.getProperty("CRUSTCAPER_TWILIO_VERIFY_API_KEY_SECRET"));
    }

    @Bean
    @Profile("local & !stage & !prod & !production")
    @ConditionalOnProperty(name = PROVIDER, havingValue = "local")
    PhoneVerificationGateway localPhoneVerification() {
        return new LocalPhoneVerificationGateway(Clock.systemUTC());
    }
}
