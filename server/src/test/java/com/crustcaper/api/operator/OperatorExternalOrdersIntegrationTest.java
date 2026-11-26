package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorExternalOrdersIntegrationTest {
    private static final String API = "/api/v1";
    private static final String OPERATOR = API + "/operator";
    private static final String EXTERNAL = OPERATOR + "/external-orders";
    private static final String CHANNELS = OPERATOR + "/external-order-channels";
    private static final String CHANNEL = "fixture-platform";
    private static final String LABEL = "Fixture delivery";
    private static final String PASSWORD = "synthetic-intake-fixture-password";
    private static final String PASSWORD_HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OperatorSessions sessions;
    @Autowired TransactionTemplate transactions;

    @Test
    void registrationIsIdempotentByStoreChannelAndReferenceAndSurvivesWorkAndChannelDisablement() throws Exception {
        String first = store();
        String second = store();
        channel(first, "other-platform", "Other fixture delivery", true);
        channel(first, "disabled-platform", "Disabled fixture delivery", false);
        Staff pickup = staff(first, "pickup");
        Staff kitchen = staff(first, "kitchen");
        Staff foreign = staff(second, "manager");

        api.perform(get(CHANNELS)).andExpect(status().isUnauthorized());
        api.perform(get(CHANNELS).header(HttpHeaders.AUTHORIZATION, kitchen.bearer())).andExpect(status().isForbidden());
        JsonNode choices = body(api.perform(get(CHANNELS).header(HttpHeaders.AUTHORIZATION, pickup.bearer()))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(choices.path("channels").size()).isEqualTo(2);
        assertThat(choices.path("channels").valueStream().map(channel -> channel.path("id").asString()).toList())
            .containsExactlyInAnyOrder(CHANNEL, "other-platform");
        api.perform(get(CHANNELS).header(HttpHeaders.AUTHORIZATION, foreign.bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.channels.length()").value(1));

        Instant scheduled = scheduled();
        String request = registration(CHANNEL, " 00Fg-a ", scheduled, 2);
        register(kitchen, request).andExpect(status().isForbidden());
        register(pickup, registration(CHANNEL, " ", scheduled, 2)).andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("invalid_input"));
        register(pickup, registration(CHANNEL, "invalid-quantity", scheduled, 0)).andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("invalid_input"));
        assertThat(countOrders(first)).isZero();
        JsonNode accepted = body(register(pickup, request).andExpect(status().isCreated())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.channelLabel").value(LABEL))
            .andExpect(jsonPath("$.externalReference").value("00Fg-a"))
            .andExpect(jsonPath("$.status").value("accepted"))
            .andExpect(jsonPath("$.confirmedByCurrentOperator").value(false))
            .andExpect(jsonPath("$.lines[0].modifiers[0]").value("no onions")));
        String id = accepted.path("id").asString();
        assertThat(Instant.parse(accepted.path("scheduledAt").asString())).isEqualTo(scheduled);
        Instant acceptedAt = Instant.parse(accepted.path("acceptedAt").asString());

        register(pickup, registration(CHANNEL, "00Fg-a", scheduled, 2)).andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(id));
        register(pickup, registration(CHANNEL, "00Fg-a", scheduled, 3)).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("external_reference_conflict"));
        register(pickup, registration(CHANNEL, "00Fg-a", scheduled.plusSeconds(60), 2)).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("external_reference_conflict"));

        String otherChannel = created(pickup, registration("other-platform", "00Fg-a", scheduled, 2));
        String otherStore = created(foreign, registration(CHANNEL, "00Fg-a", scheduled, 2));
        String otherCase = created(pickup, registration(CHANNEL, "00FG-a", scheduled, 2));
        assertThat(List.of(id, otherChannel, otherStore, otherCase)).doesNotHaveDuplicates();
        assertThat(countOrders(first)).isEqualTo(3);
        assertThat(countOrders(second)).isOne();
        assertThat(jdbc.sql("SELECT registered_by FROM operator_external_orders WHERE id = ?")
            .param(UUID.fromString(id)).query(UUID.class).single()).isEqualTo(pickup.id());

        change(kitchen, id, "preparing", null).andExpect(status().isOk());
        jdbc.sql("UPDATE operator_external_order_channels SET enabled = false, label = 'Renamed' WHERE store_id = ? AND id = ?")
            .params(first, CHANNEL).update();
        JsonNode replay = body(register(pickup, request).andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(id)).andExpect(jsonPath("$.status").value("preparing"))
            .andExpect(jsonPath("$.channelLabel").value(LABEL)));
        assertThat(Instant.parse(replay.path("acceptedAt").asString())).isEqualTo(acceptedAt);
        register(pickup, registration(CHANNEL, "brand-new", scheduled, 2)).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("external_channel_unavailable"));
        assertThat(countOrders(first)).isEqualTo(3);
    }

    @Test
    void transitionsUseScopedRolesAndExactCollectionReferenceAndAuditTheActorOnlyOnce() throws Exception {
        String own = store();
        Staff collector = staff(own, "pickup");
        Staff manager = staff(own, "manager");
        Staff kitchen = staff(own, "kitchen");
        Staff foreign = staff(store(), "manager");
        String request = registration(CHANNEL, "0004-Aa", scheduled(), 1);
        String id = created(collector, request);

        api.perform(get(EXTERNAL + "/{id}", id)).andExpect(status().isUnauthorized());
        read(foreign, id).andExpect(status().isNotFound());
        change(foreign, id, "preparing", null).andExpect(status().isNotFound());
        change(collector, id, "preparing", null).andExpect(status().isForbidden());
        change(collector, id, "cancelled", null).andExpect(status().isForbidden());
        change(kitchen, id, "ready", null).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("invalid_transition"));
        change(kitchen, id, "preparing", null).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("preparing"));
        change(kitchen, id, "ready", null).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ready"));
        change(kitchen, id, "preparing", null).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ready"));
        change(kitchen, id, "collected", "0004-Aa").andExpect(status().isForbidden());
        for (String wrong : List.of("4-Aa", "0004-AA")) {
            change(collector, id, "collected", wrong).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("external_reference_mismatch"));
        }
        read(collector, id).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ready"))
            .andExpect(jsonPath("$.confirmedByCurrentOperator").value(false));
        change(collector, id, "collected", "0004-Aa").andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("collected"))
            .andExpect(jsonPath("$.confirmedByCurrentOperator").value(true));
        change(collector, id, "collected", "0004-Aa").andExpect(status().isOk())
            .andExpect(jsonPath("$.confirmedByCurrentOperator").value(true));
        read(collector, id).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("collected"))
            .andExpect(jsonPath("$.confirmedByCurrentOperator").value(true));
        read(manager, id).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("collected"))
            .andExpect(jsonPath("$.confirmedByCurrentOperator").value(false));
        change(manager, id, "collected", "0004-Aa").andExpect(status().isConflict());
        change(manager, id, "cancelled", null).andExpect(status().isConflict());
        assertThat(events(id)).containsExactlyInAnyOrder(
            new Audit(kitchen.id(), "kitchen", "accepted", "preparing"),
            new Audit(kitchen.id(), "kitchen", "preparing", "ready"),
            new Audit(collector.id(), "pickup", "ready", "collected"));
        assertThat(queue(collector).path("externalOrders").size()).isZero();

        String cancelled = created(collector, registration(CHANNEL, "0005-Bb", scheduled(), 1));
        change(manager, cancelled, "cancelled", null).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("cancelled"));
        change(manager, cancelled, "cancelled", null).andExpect(status().isOk());
        read(manager, cancelled).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"));
        change(kitchen, cancelled, "preparing", null).andExpect(status().isConflict());
        assertThat(events(cancelled)).containsExactly(new Audit(manager.id(), "manager", "accepted", "cancelled"));
        assertThat(queue(kitchen).path("externalOrders").size()).isZero();
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void concurrentIntakeAndCollectionRetriesReturnTheCommittedOutcomeAndRecordEachActionOnce() throws Exception {
        Staff manager = transactions.execute(tx -> staff(store(), "manager"));
        try (var executor = Executors.newFixedThreadPool(2)) {
            String reference = "same-concurrent-ref";
            String request = registration(CHANNEL, reference, scheduled(), 1);
            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch start = new CountDownLatch(1);
            Callable<Registration> create = () -> {
                ready.countDown();
                assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                var response = register(manager, request).andReturn().getResponse();
                return new Registration(response.getStatus(),
                    json.readTree(response.getContentAsByteArray()).path("id").asString(""));
            };
            var first = executor.submit(create);
            var second = executor.submit(create);
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            Registration left = first.get(10, TimeUnit.SECONDS);
            Registration right = second.get(10, TimeUnit.SECONDS);
            assertThat(List.of(left.status(), right.status())).containsExactlyInAnyOrder(201, 200);
            assertThat(left.id()).isNotEmpty().isEqualTo(right.id());
            assertThat(countOrders(manager.store())).isOne();
            assertThat(queue(manager).path("externalOrders").size()).isOne();

            String id = left.id();
            change(manager, id, "preparing", null).andExpect(status().isOk());
            change(manager, id, "ready", null).andExpect(status().isOk());
            CountDownLatch firstCollectionWritten = new CountDownLatch(1);
            CountDownLatch allowCommit = new CountDownLatch(1);
            var firstCollection = executor.submit(() -> transactions.execute(tx -> {
                collectConfirmed(manager, id, reference);
                firstCollectionWritten.countDown();
                try {
                    assertThat(allowCommit.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted waiting for the retry", interrupted);
                }
                return null;
            }));
            try {
                assertThat(firstCollectionWritten.await(10, TimeUnit.SECONDS)).isTrue();
                var retryCollection = executor.submit(() -> collectConfirmed(manager, id, reference));
                // The retry's SELECT starts while the winning collection and its audit row are uncommitted.
                waitForCollectionLock();
                allowCommit.countDown();
                firstCollection.get(10, TimeUnit.SECONDS);
                retryCollection.get(10, TimeUnit.SECONDS);
            } finally {
                allowCommit.countDown();
            }
            assertThat(events(id)).filteredOn(event -> event.requested().equals("collected")).containsExactly(
                new Audit(manager.id(), "manager", "ready", "collected"));
        } finally {
            transactions.executeWithoutResult(tx -> {
                jdbc.sql("DELETE FROM operator_external_order_events WHERE order_id IN (SELECT id FROM operator_external_orders WHERE store_id = ?)")
                    .param(manager.store()).update();
                jdbc.sql("DELETE FROM operator_external_orders WHERE store_id = ?").param(manager.store()).update();
                jdbc.sql("DELETE FROM operator_external_order_channels WHERE store_id = ?").param(manager.store()).update();
                jdbc.sql("DELETE FROM operator_sessions WHERE operator_id = ?").param(manager.id()).update();
                jdbc.sql("DELETE FROM operator_accounts WHERE id = ?").param(manager.id()).update();
                jdbc.sql("DELETE FROM stores WHERE id = ?").param(manager.store()).update();
            });
        }
    }

    @Test
    void kitchenQueueShowsPaidOnlineOrdersAndExternalJobsStayOutsideCustomerAndFinancialApis() throws Exception {
        String store = store();
        Staff manager = staff(store, "manager");
        Staff kitchen = staff(store, "kitchen");
        Staff foreign = staff(store(), "kitchen");
        String guestToken = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk()))
            .path("accessToken").asString();
        String guest = "Bearer " + guestToken;
        String online = paidOnlineOrder(store, guest);
        long guestSessions = jdbc.sql("SELECT count(*) FROM guest_sessions").query(Long.class).single();
        String external = created(manager, registration(CHANNEL, "only-kitchen", scheduled(), 2));

        JsonNode queue = queue(kitchen);
        assertThat(queue.path("orders").size()).isOne();
        assertThat(queue.path("orders").get(0).path("id").asString()).isEqualTo(online);
        assertThat(queue.path("orders").get(0).propertyNames()).containsExactlyInAnyOrder(
            "id", "status", "paymentStatus", "lines", "total", "currency", "pickupStartsAt", "pickupEndsAt", "acceptedAt");
        assertThat(queue.path("externalOrders").size()).isOne();
        JsonNode job = queue.path("externalOrders").get(0);
        assertThat(job.path("id").asString()).isEqualTo(external);
        assertThat(job.propertyNames()).containsExactlyInAnyOrder("id", "channel", "channelLabel", "externalReference",
            "scheduledAt", "acceptedAt", "status", "lines", "confirmedByCurrentOperator");
        assertThat(job.path("lines").get(0).propertyNames()).containsExactlyInAnyOrder("name", "quantity", "modifiers");
        assertThat(queue(foreign).path("orders").size()).isZero();
        assertThat(queue(foreign).path("externalOrders").size()).isZero();

        api.perform(get(EXTERNAL + "/{id}", external).header(HttpHeaders.AUTHORIZATION, guest))
            .andExpect(status().isUnauthorized());
        api.perform(get(API + "/orders/{id}", external).header(HttpHeaders.AUTHORIZATION, guest))
            .andExpect(status().isNotFound());
        api.perform(get(API + "/orders/{id}/receipt", external).header(HttpHeaders.AUTHORIZATION, guest))
            .andExpect(status().isNotFound());
        api.perform(post(API + "/orders/{id}/payments", external).header(HttpHeaders.AUTHORIZATION, guest)
            .header("Idempotency-Key", "external-must-not-start-payment")).andExpect(status().isNotFound());
        assertThat(jdbc.sql("SELECT count(*) FROM guest_sessions").query(Long.class).single()).isEqualTo(guestSessions);
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store).query(Long.class).single()).isOne();
        assertThat(jdbc.sql("SELECT count(*) FROM quotes WHERE store_id = ?").param(store).query(Long.class).single()).isOne();
        assertThat(jdbc.sql("SELECT count(*) FROM payment_attempts WHERE order_id = ?")
            .param(UUID.fromString(online)).query(Long.class).single()).isOne();
        assertThat(jdbc.sql("SELECT count(*) FROM payment_attempts WHERE order_id = ?")
            .param(UUID.fromString(external)).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("SELECT count(*) FROM fiscal_receipts WHERE store_id = ?")
            .param(store).query(Long.class).single()).isZero();
    }

    private String store() {
        String id = "intake-test-" + UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            VALUES (?, '{"en":"Fixture","rw":"Fixture"}', '{"en":"Fixture","rw":"Fixture"}',
                '{"en":"Fixture","rw":"Fixture"}', true, 0, 'test')
            """).param(id).update();
        channel(id, CHANNEL, LABEL, true);
        return id;
    }

    private void channel(String store, String id, String label, boolean enabled) {
        jdbc.sql("INSERT INTO operator_external_order_channels (store_id, id, label, enabled) VALUES (?, ?, ?, ?)")
            .params(store, id, label, enabled).update();
    }

    private Staff staff(String store, String role) {
        UUID id = UUID.randomUUID();
        String username = "intake-staff-" + id;
        jdbc.sql("INSERT INTO operator_accounts (id, username, store_id, role, password_hash) VALUES (?, ?, ?, ?, ?)")
            .params(id, username, store, role, PASSWORD_HASH).update();
        OperatorModels.Session session = sessions.open(new OperatorModels.Login(username, PASSWORD));
        return new Staff(id, store, "Bearer " + session.accessToken());
    }

    private static Instant scheduled() {
        return Instant.now().plusSeconds(30 * 60).truncatedTo(ChronoUnit.SECONDS);
    }

    private String registration(String channel, String reference, Instant time, int quantity) {
        return json.writeValueAsString(Map.of("channel", channel, "externalReference", reference,
            "scheduledAt", time.toString(), "lines", List.of(Map.of("name", "Fixture meal", "quantity", quantity,
                "modifiers", List.of("no onions")))));
    }

    private ResultActions register(Staff actor, String request) throws Exception {
        return api.perform(post(EXTERNAL).header(HttpHeaders.AUTHORIZATION, actor.bearer())
            .contentType(MediaType.APPLICATION_JSON).content(request));
    }

    private String created(Staff actor, String request) throws Exception {
        return body(register(actor, request).andExpect(status().isCreated())).path("id").asString();
    }

    private ResultActions read(Staff actor, String id) throws Exception {
        return api.perform(get(EXTERNAL + "/{id}", id).header(HttpHeaders.AUTHORIZATION, actor.bearer()));
    }

    private ResultActions change(Staff actor, String id, String status, String reference) throws Exception {
        Map<String, String> input = reference == null ? Map.of("status", status)
            : Map.of("status", status, "externalReference", reference);
        return api.perform(post(EXTERNAL + "/{id}/status", id).header(HttpHeaders.AUTHORIZATION, actor.bearer())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(input)));
    }

    private void collectConfirmed(Staff actor, String id, String reference) {
        try {
            change(actor, id, "collected", reference).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("collected"))
                .andExpect(jsonPath("$.confirmedByCurrentOperator").value(true));
        } catch (Exception error) {
            throw new IllegalStateException("Could not collect the fixture order", error);
        }
    }

    private void waitForCollectionLock() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            boolean waiting = jdbc.sql("""
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                      AND query LIKE '%operator_external_orders%' AND query LIKE '%FOR UPDATE OF o%')
                """).query(Boolean.class).single();
            if (waiting) return;
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("The collection retry did not wait for the uncommitted order transition");
    }

    private JsonNode queue(Staff actor) throws Exception {
        return body(api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, actor.bearer()))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
    }

    private JsonNode body(ResultActions actions) throws Exception {
        return json.readTree(actions.andReturn().getResponse().getContentAsByteArray());
    }

    private long countOrders(String store) {
        return jdbc.sql("SELECT count(*) FROM operator_external_orders WHERE store_id = ?")
            .param(store).query(Long.class).single();
    }

    private List<Audit> events(String order) {
        return jdbc.sql("""
            SELECT operator_id, operator_role, previous_status, requested_status
            FROM operator_external_order_events WHERE order_id = ?
            """).param(UUID.fromString(order)).query((row, index) -> new Audit(row.getObject("operator_id", UUID.class),
                row.getString("operator_role"), row.getString("previous_status"), row.getString("requested_status"))).list();
    }

    private String paidOnlineOrder(String store, String guest) throws Exception {
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'intake-test-slot', now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).param(store).update();
        String quote = body(api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, guest)
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"storeId":"%s","slotId":"intake-test-slot","lines":[{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]}
                """.formatted(store))).andExpect(status().isOk())).path("quoteId").asString();
        String order = body(api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, guest)
            .header("Idempotency-Key", "intake-mixed-fixture-order").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("quoteId", quote, "phone", "+250700000000"))))
            .andExpect(status().isOk())).path("id").asString();
        String attempt = body(api.perform(post(API + "/orders/{id}/payments", order).header(HttpHeaders.AUTHORIZATION, guest)
            .header("Idempotency-Key", "intake-mixed-fixture-payment")).andExpect(status().isOk())).path("id").asString();
        api.perform(post(API + "/local/orders/{id}/payments/{attempt}/result", order, attempt)
            .header(HttpHeaders.AUTHORIZATION, guest).contentType(MediaType.APPLICATION_JSON)
            .content("{\"status\":\"paid\"}")).andExpect(status().isOk());
        return order;
    }

    private record Staff(UUID id, String store, String bearer) { }
    private record Registration(int status, String id) { }
    private record Audit(UUID operator, String role, String previous, String requested) { }
}
