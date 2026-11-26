package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.crustcaper.api.payment.PaymentGateway;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;

class PaymentReconciliationConfigurationTest {
    private final ApplicationContextRunner stage = new ApplicationContextRunner()
        .withUserConfiguration(Scheduling.class, PaymentReconciliationConfiguration.class, PaymentReconciliationMetrics.class)
        .withPropertyValues("crustcaper.payment.provider=flutterwave")
        .withBean(JdbcClient.class, () -> mock(JdbcClient.class))
        .withBean(PaymentGateway.class, () -> mock(PaymentGateway.class))
        .withBean(OrderService.class, () -> mock(OrderService.class))
        .withBean(MeterRegistry.class, SimpleMeterRegistry::new);

    @Test
    void registersOneJobForFlutterwaveAndHonorsTheEmergencySwitch() {
        stage.run(context -> {
            assertThat(context).hasSingleBean(PaymentReconciliation.class);
            assertThat(context.getBean(ScheduledAnnotationBeanPostProcessor.class).getScheduledTasks()).hasSize(1);
            assertThat(context.getBean(PaymentReconciliationMetrics.class).snapshot().enabled()).isTrue();
        });
        stage.withPropertyValues("crustcaper.payment.reconciliation.enabled=false").run(context -> {
            assertThat(context).doesNotHaveBean(PaymentReconciliation.class);
            assertThat(context.getBean(ScheduledAnnotationBeanPostProcessor.class).getScheduledTasks()).isEmpty();
            assertThat(context.getBean(PaymentReconciliationMetrics.class).snapshot().enabled()).isFalse();
        });
    }

    @Test
    void aFailedClaimCountsAnAbortedSweepAndStillReachesTheSchedulerErrorHandler() {
        stage.run(context -> {
            var jdbc = context.getBean(JdbcClient.class);
            var failure = new DataAccessResourceFailureException("Synthetic unavailable PostgreSQL");
            when(jdbc.sql(anyString())).thenThrow(failure);
            var worker = context.getBean(PaymentReconciliation.class);
            var telemetry = context.getBean(PaymentReconciliationMetrics.class);

            assertThatThrownBy(worker::poll).isSameAs(failure);

            assertThat(telemetry.snapshot()).isEqualTo(new PaymentReconciliationMetrics.Snapshot(
                telemetry.snapshot().instanceId(), true, 0, 0, 0, 0, 0, 0, 1));
            verifyNoInteractions(context.getBean(PaymentGateway.class));
        });
    }

    @Configuration(proxyBeanMethods = false)
    @EnableScheduling
    static class Scheduling { }
}
