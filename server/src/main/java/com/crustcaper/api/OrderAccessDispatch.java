package com.crustcaper.api;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "crustcaper.order-access.provider")
class OrderAccessDispatch {
    private final OrderAccessService service;

    OrderAccessDispatch(OrderAccessService service) {
        this.service = service;
    }

    @Bean("orderAccessScheduler")
    static ThreadPoolTaskScheduler orderAccessScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("order-access-");
        return scheduler;
    }

    @Scheduled(scheduler = "orderAccessScheduler", fixedDelayString = "${crustcaper.order-access.dispatch-delay:PT1S}")
    void dispatch() {
        service.dispatch();
    }
}
