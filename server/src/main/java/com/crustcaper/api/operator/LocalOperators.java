package com.crustcaper.api.operator;

import java.util.Arrays;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
@Profile("local & !stage & !prod & !production")
@ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "local")
final class LocalOperators {
    private final JdbcClient jdbc;

    LocalOperators(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void seedLocalOperators() {
        seed("kitchen");
        seed("pickup");
        seed("manager");
    }

    private void seed(String role) {
        char[] password = "local-demo-passphrase".toCharArray();
        try {
            jdbc.sql("""
                    INSERT INTO operator_accounts (id, store_id, username, role, password_hash)
                    VALUES (?, 'kigali', ?, ?, ?) ON CONFLICT (username) DO NOTHING
                    """).params(UUID.randomUUID(), "demo-" + role, role, OperatorPasswordHash.hash(password)).update();
        } finally {
            Arrays.fill(password, '\0');
        }
    }
}
