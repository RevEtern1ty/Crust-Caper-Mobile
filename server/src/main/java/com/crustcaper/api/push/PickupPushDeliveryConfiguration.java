package com.crustcaper.api.push;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "crustcaper.push.provider", havingValue = "expo")
class PickupPushDeliveryConfiguration {
    @Bean
    ExpoPushHttpTransport pickupPushTransport(ObjectMapper mapper, Environment environment) {
        boolean stage = environment.acceptsProfiles(Profiles.of("stage"));
        boolean production = environment.acceptsProfiles(Profiles.of("production", "prod"));
        if (stage == production || environment.acceptsProfiles(Profiles.of("local"))) {
            throw new IllegalStateException("Expo push requires a stage or production Spring profile without local");
        }
        return new ExpoPushHttpTransport(mapper, environment.getProperty("crustcaper.push.expo-access-token"));
    }

    @Bean
    PickupPushWorker pickupPushWorker(JdbcClient jdbc, TransactionTemplate transactions, PickupPushCipher cipher,
                                      ExpoPushTransport transport, MeterRegistry meters) {
        return new PickupPushWorker(jdbc, transactions, cipher, transport, meters);
    }

    @Bean
    ThreadPoolTaskScheduler pickupPushScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        scheduler.setThreadNamePrefix("crustcaper-pickup-push-");
        return scheduler;
    }
}
