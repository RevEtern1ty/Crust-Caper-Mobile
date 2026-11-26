package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class PopulatedDatabaseMigrationTest {
    private static final Pattern TEST_DATABASE = Pattern.compile(
        "jdbc:postgresql://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):[1-9][0-9]{0,4}/crustcaper_(?:dev|test)(?:_[a-z0-9_]+)?");
    private static final String STORE = "migration-v22";
    private static final String PHONE = "+250700000000";
    private static final String PAYMENT_KEY = "migration-payment";
    private static final String PENDING_CHECKOUT_URL = "https://checkout.example.test/pay/migration";
    private static final String LINES = """
        [{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]
        """;

    record Migration(int rank, String version, String script, Integer checksum, boolean success) {}
    record Purchase(UUID guest, UUID quote, UUID order, UUID attempt, String channel) {
        Purchase(String channel) {
            this(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), channel);
        }

        String orderKey() { return "migration-order-" + channel; }
    }

    @Test
    void upgradesPopulatedV22AndRecoversTheSamePendingMobileOrder() throws Exception {
        String url = System.getenv().getOrDefault("CRUSTCAPER_DB_URL", "jdbc:postgresql://127.0.0.1:55432/crustcaper_dev");
        if (!TEST_DATABASE.matcher(url).matches()) {
            throw new IllegalStateException("Run this test on a dedicated loopback crustcaper_dev or crustcaper_test database");
        }
        String user = System.getenv().getOrDefault("CRUSTCAPER_DB_USER", "crustcaper");
        String password = System.getenv().getOrDefault("CRUSTCAPER_DB_PASSWORD", "crustcaper-local");
        String schema = "migration_upgrade_test_" + UUID.randomUUID().toString().replace("-", "");
        JdbcClient admin = JdbcClient.create(new DriverManagerDataSource(url, user, password));
        admin.sql("CREATE SCHEMA " + schema).update();
        try {
            String scopedUrl = url + "?currentSchema=" + schema;
            var datasource = new DriverManagerDataSource(scopedUrl, user, password);
            JdbcClient jdbc = JdbcClient.create(datasource);
            Flyway.configure().dataSource(datasource).defaultSchema(schema).schemas(schema).createSchemas(false)
                .cleanDisabled(true).target("22").load().migrate();
            List<Migration> historyAtV22 = history(jdbc);
            assertThat(historyAtV22).hasSize(22).allMatch(Migration::success);
            assertThat(historyAtV22.getLast().version()).isEqualTo("22");

            var paid = new Purchase("web");
            var pending = new Purchase("mobile");
            UUID ordinaryChallenge = UUID.randomUUID();
            byte[] receipt = receiptPdf();
            seedV22(jdbc, paid, pending, ordinaryChallenge, receipt);
            List<String> previousOrders = orderWitnesses(jdbc);
            assertThat(previousOrders).hasSize(2);

            try (var application = startCandidate(scopedUrl, schema, user, password)) {
                assertThat(application.getBean(JdbcClient.class).sql("SELECT current_schema()")
                    .query(String.class).single()).isEqualTo(schema);
                List<Migration> upgraded = history(jdbc);
                assertThat(upgraded).hasSizeGreaterThan(22).allMatch(Migration::success);
                assertThat(upgraded.subList(0, 22)).containsExactlyElementsOf(historyAtV22);
                assertThat(upgraded.get(22).version()).isEqualTo("23");
                assertThat(upgraded.get(22).script()).isEqualTo("V23__mobile_checkout_recovery.sql");
                assertThat(orderWitnesses(jdbc)).containsExactlyElementsOf(previousOrders);
                assertThat(jdbc.sql("SELECT mobile_checkout_recovery FROM order_access_challenges")
                    .query(Boolean.class).list()).containsExactly(false, false);
                assertThat(jdbc.sql("SELECT count(mobile_checkout_guest_session_id) FROM orders WHERE store_id = ?")
                    .param(STORE).query(Long.class).single()).isZero();

                var orders = application.getBean(OrderService.class);
                assertThat(orders.getOrder(paid.guest(), paid.order()).paymentAttempt().id()).isEqualTo(paid.attempt());
                assertThat(orders.receiptDocument(paid.guest(), paid.order())).containsExactly(receipt);
                assertThat(orders.getOrder(pending.guest(), pending.order()).paymentAttempt().checkoutUrl())
                    .isEqualTo(PENDING_CHECKOUT_URL);
                assertNewConstraints(jdbc, paid, pending, ordinaryChallenge);
                recoverPendingOrder(application, jdbc, pending);
                assertThat(orderWitnesses(jdbc)).containsExactlyElementsOf(previousOrders);
            }
        } finally {
            // This identifier is generated here, and ownership requires the CREATE SCHEMA above to succeed.
            admin.sql("DROP SCHEMA " + schema + " CASCADE").update();
        }
    }

    private static ConfigurableApplicationContext startCandidate(String url, String schema, String user, String password) {
        var environment = new StandardEnvironment();
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        environment.setActiveProfiles("local");
        environment.getPropertySources().addFirst(new MapPropertySource("populatedMigrationFixture", Map.ofEntries(
            Map.entry("spring.datasource.url", url), Map.entry("spring.datasource.username", user),
            Map.entry("spring.datasource.password", password), Map.entry("spring.datasource.hikari.maximum-pool-size", "2"),
            Map.entry("spring.flyway.url", url), Map.entry("spring.flyway.user", user), Map.entry("spring.flyway.password", password),
            Map.entry("spring.flyway.schemas", schema), Map.entry("spring.flyway.default-schema", schema),
            Map.entry("spring.flyway.create-schemas", "false"), Map.entry("spring.flyway.target", "latest"),
            Map.entry("crustcaper.payment.provider", "local"), Map.entry("crustcaper.push.provider", "disabled"),
            Map.entry("crustcaper.order-access.provider", "local"),
            Map.entry("crustcaper.order-access.dispatch-delay", "PT1H"))));
        return new SpringApplicationBuilder(CrustCaperApplication.class).web(WebApplicationType.NONE)
            .environment(environment).registerShutdownHook(false).run();
    }

    private static List<Migration> history(JdbcClient jdbc) {
        return jdbc.sql("""
            SELECT installed_rank, version, script, checksum, success
            FROM flyway_schema_history ORDER BY installed_rank
            """).query((row, index) -> new Migration(row.getInt("installed_rank"), row.getString("version"),
                row.getString("script"), row.getObject("checksum", Integer.class), row.getBoolean("success"))).list();
    }

    private static List<String> orderWitnesses(JdbcClient jdbc) {
        // Select the V22 fields explicitly so additive future migrations do not change the comparison.
        return jdbc.sql("""
            SELECT jsonb_build_array(o.id, o.quote_id, o.guest_session_id, o.request_key, o.slot_id,
                o.lines, o.total, o.tax, o.status, o.payment_status, o.receipt_status, o.receipt_url,
                o.created_at, o.reservation_expires_at, o.pickup_starts_at, o.pickup_ends_at, o.accepted_at,
                o.checkout_channel, p.id, p.sequence, p.request_key, p.status, p.checkout_url,
                p.provider_transaction_id, p.verified_at, f.reference, f.sha256, f.attached_by,
                e.id, e.operator_id, e.previous_status, e.requested_status, e.outcome)::text
            FROM orders o JOIN payment_attempts p ON p.order_id = o.id
            LEFT JOIN fiscal_receipts f ON f.order_id = o.id
            LEFT JOIN operator_order_events e ON e.order_id = o.id
            WHERE o.store_id = ? ORDER BY o.id, p.id, e.id
            """).param(STORE).query(String.class).list();
    }

    private static void seedV22(JdbcClient jdbc, Purchase paid, Purchase pending, UUID ordinaryChallenge, byte[] receipt) {
        UUID manager = UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO stores(id, name, area, hours, open, tax_basis_points, version)
            VALUES (?, '{"en":"Migration fixture","rw":"Migration fixture"}', '{}', '{}', true, 1800, 'v22-fixture')
            """).param(STORE).update();
        jdbc.sql("""
            INSERT INTO pickup_slots(store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'old-slot', now() + interval '20 minutes', now() + interval '30 minutes', 4)
            """).param(STORE).update();
        jdbc.sql("""
            INSERT INTO guest_sessions(id, token_hash, web_token_hash, expires_at) VALUES
              (?, NULL, repeat('a', 64), now() + interval '1 hour'),
              (?, repeat('b', 64), NULL, now() + interval '1 hour')
            """).params(paid.guest(), pending.guest()).update();
        jdbc.sql("""
            INSERT INTO operator_accounts(id, store_id, username, role, password_hash)
            VALUES (?, ?, 'migration-fixture-manager', 'manager', 'synthetic-unused-hash')
            """).params(manager, STORE).update();
        seedPurchase(jdbc, paid, true);
        seedPurchase(jdbc, pending, false);
        jdbc.sql("""
            INSERT INTO fiscal_receipts(order_id, store_id, reference, total_rwf, document, attached_by)
            VALUES (?, ?, 'V22-EBM', 9200, ?, ?)
            """).params(paid.order(), STORE, receipt, manager).update();
        jdbc.sql("""
            INSERT INTO operator_order_events(order_id, store_id, operator_id, operator_role, previous_status,
                requested_status, outcome) VALUES (?, ?, ?, 'manager', 'ready', 'collected', 'changed')
            """).params(paid.order(), STORE, manager).update();
        jdbc.sql("""
            INSERT INTO order_access_challenges(id, guest_session_id, order_code, phone_digest, order_id,
                checkout_recovery, state, expires_at) VALUES
              (?, ?, NULL, sha256('old-web'::bytea), ?, true, 'closed', now() + interval '5 minutes'),
              (?, ?, '0000ab12', sha256('old-mobile'::bytea), ?, false, 'closed', now() + interval '5 minutes')
            """).params(UUID.randomUUID(), paid.guest(), paid.order(), ordinaryChallenge, pending.guest(), pending.order()).update();
    }

    private static void seedPurchase(JdbcClient jdbc, Purchase purchase, boolean paid) {
        jdbc.sql("""
            INSERT INTO quotes(id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at,
                lines, total, tax, expires_at, web_checkout)
            SELECT ?, ?, store_id, id, starts_at, ends_at, CAST(? AS jsonb), 9200, 1403,
                now() + interval '5 minutes', ? FROM pickup_slots WHERE store_id = ? AND id = 'old-slot'
            """).params(purchase.quote(), purchase.guest(), LINES, purchase.channel().equals("web"), STORE).update();
        jdbc.sql("""
            INSERT INTO orders(id, quote_id, guest_session_id, request_key, store_id, slot_id, phone, lines, total,
                tax, status, payment_status, receipt_status, receipt_url, created_at, reservation_expires_at,
                pickup_starts_at, pickup_ends_at, accepted_at, checkout_channel)
            SELECT ?, id, guest_session_id, ?, store_id, slot_id, ?, lines, total, tax, ?, ?, ?, ?,
                now() - interval '2 minutes', now() + interval '8 minutes', pickup_starts_at, pickup_ends_at,
                CASE WHEN ? THEN now() - interval '1 minute' END, ? FROM quotes WHERE id = ?
            """).params(purchase.order(), purchase.orderKey(), PHONE, paid ? "collected" : "awaiting_payment",
                paid ? "paid" : "processing", paid ? "issued" : "pending",
                paid ? "/api/v1/orders/" + purchase.order() + "/receipt" : null, paid, purchase.channel(), purchase.quote()).update();
        jdbc.sql("""
            INSERT INTO payment_attempts(id, order_id, request_key, status, checkout_url, provider_transaction_id, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN now() - interval '1 minute' END)
            """).params(purchase.attempt(), purchase.order(), PAYMENT_KEY, paid ? "paid" : "processing",
                paid ? null : PENDING_CHECKOUT_URL, paid ? "88552214" : null, paid).update();
    }

    private static byte[] receiptPdf() throws IOException {
        try (var pdf = new PDDocument()) {
            pdf.addPage(new PDPage(PDRectangle.A6));
            pdf.getDocumentInformation().setTitle("Synthetic V22 fiscal receipt");
            var bytes = new ByteArrayOutputStream();
            pdf.save(bytes);
            return bytes.toByteArray();
        }
    }

    private static void assertNewConstraints(JdbcClient jdbc, Purchase paid, Purchase pending, UUID ordinaryChallenge) {
        assertThatThrownBy(() -> jdbc.sql("UPDATE orders SET mobile_checkout_guest_session_id = ? WHERE id = ?")
            .params(pending.guest(), paid.order()).update()).isInstanceOfSatisfying(DataIntegrityViolationException.class,
                failure -> assertConstraint(failure, "23514", "mobile_checkout_guest_channel"));
        assertThatThrownBy(() -> jdbc.sql("UPDATE order_access_challenges SET mobile_checkout_recovery = true WHERE id = ?")
            .param(ordinaryChallenge).update()).isInstanceOfSatisfying(DataIntegrityViolationException.class,
                failure -> assertConstraint(failure, "23514", "mobile_checkout_recovery_purpose"));
        assertThatThrownBy(() -> jdbc.sql("UPDATE orders SET mobile_checkout_guest_session_id = ? WHERE id = ?")
            .params(UUID.randomUUID(), pending.order()).update()).isInstanceOfSatisfying(DataIntegrityViolationException.class,
                failure -> assertConstraint(failure, "23503", "orders_mobile_checkout_guest_session_id_fkey"));
    }

    private static void assertConstraint(DataIntegrityViolationException failure, String code, String name) {
        assertThat(failure.getMostSpecificCause()).isInstanceOfSatisfying(SQLException.class, cause -> {
            assertThat(cause.getSQLState()).isEqualTo(code);
            assertThat(cause.getMessage()).contains(name);
        });
    }

    private static void recoverPendingOrder(ConfigurableApplicationContext application, JdbcClient jdbc, Purchase pending) {
        var guests = application.getBean(GuestSessions.class);
        String bearer = "Bearer " + guests.create().accessToken();
        UUID replacement = guests.authenticate(bearer);
        var access = application.getBean(OrderAccessService.class);
        var recovery = application.getBean(CheckoutRecoveryController.class).recoverMobile(bearer,
            new CheckoutRecoveryController.Input(pending.quote().toString(), pending.orderKey(), PHONE)).getBody();
        assertThat(recovery).isNotNull();
        assertThat(recovery.state()).isEqualTo("verify");
        access.dispatch();
        assertThat(access.verify(replacement, recovery.challengeId(), "418263").orderId()).isEqualTo(pending.order());
        assertThat(jdbc.sql("""
            SELECT o.mobile_checkout_guest_session_id = ? AND c.checkout_recovery AND c.mobile_checkout_recovery
              AND c.state = 'verified' AND g.privacy_verified_at IS NULL
            FROM orders o JOIN order_access_challenges c ON c.order_id = o.id
            JOIN order_read_grants g ON g.order_id = o.id AND g.guest_session_id = c.guest_session_id
            WHERE o.id = ? AND c.id = ?
            """).params(replacement, pending.order(), recovery.challengeId()).query(Boolean.class).single()).isTrue();
        var orders = application.getBean(OrderService.class);
        assertThat(orders.getOrder(replacement, pending.order()).paymentAttempt().id()).isEqualTo(pending.attempt());
        assertThat(orders.startPayment(replacement, pending.order(), PAYMENT_KEY).id()).isEqualTo(pending.attempt());
    }
}
