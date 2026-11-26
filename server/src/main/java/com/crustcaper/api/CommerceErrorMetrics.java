package com.crustcaper.api;

import java.util.UUID;
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation;
import org.springframework.boot.actuate.endpoint.web.annotation.WebEndpoint;
import org.springframework.stereotype.Component;

@Component
@WebEndpoint(id = "commerceerrors")
final class CommerceErrorMetrics {
    record Snapshot(UUID instanceId, long requests, long serverErrors) {}

    private final UUID instanceId = UUID.randomUUID();
    private long requests;
    private long serverErrors;

    synchronized void record(boolean serverError) {
        requests++;
        if (serverError) serverErrors++;
    }

    @ReadOperation
    public synchronized Snapshot snapshot() {
        return new Snapshot(instanceId, requests, serverErrors);
    }
}
