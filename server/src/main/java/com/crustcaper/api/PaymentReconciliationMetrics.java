package com.crustcaper.api;

import java.util.EnumMap;
import java.util.UUID;
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation;
import org.springframework.boot.actuate.endpoint.web.annotation.WebEndpoint;
import org.springframework.stereotype.Component;

@Component
@WebEndpoint(id = "paymentreconciliation")
final class PaymentReconciliationMetrics {
    enum Result {
        CONFIRMED("verified"),
        PENDING("pending"),
        PROVIDER_ERROR("provider_error"),
        REJECTED("rejected"),
        SETTLEMENT_ERROR("settlement_error");

        final String meterTag;

        Result(String meterTag) { this.meterTag = meterTag; }
    }

    record Snapshot(UUID instanceId, boolean enabled, long sweeps, long confirmed, long pending,
                    long providerErrors, long rejected, long settlementErrors, long sweepErrors) {}

    private final UUID instanceId = UUID.randomUUID();
    private final EnumMap<Result, Long> outcomes = new EnumMap<>(Result.class);
    private boolean enabled;
    private long sweeps;
    private long sweepErrors;

    synchronized void enable() {
        enabled = true;
    }

    synchronized void record(Result result) {
        outcomes.merge(result, 1L, Long::sum);
    }

    synchronized void completeSweep() {
        sweeps++;
    }

    synchronized void abortSweep() {
        sweepErrors++;
    }

    @ReadOperation
    public synchronized Snapshot snapshot() {
        return new Snapshot(instanceId, enabled, sweeps, total(Result.CONFIRMED), total(Result.PENDING),
            total(Result.PROVIDER_ERROR), total(Result.REJECTED), total(Result.SETTLEMENT_ERROR), sweepErrors);
    }

    private long total(Result result) {
        return outcomes.getOrDefault(result, 0L);
    }
}
