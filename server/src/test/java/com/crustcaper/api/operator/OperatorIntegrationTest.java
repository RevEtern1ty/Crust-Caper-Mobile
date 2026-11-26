package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.OrderService;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class OperatorIntegrationTest {
    private static final String API = "/api/v1";
    private static final String OPERATOR = API + "/operator";
    private static final String PASSWORD = "synthetic-operator-fixture";
    private static final String PASSWORD_HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());
    private static final String SLOT = "operator-test-slot";
    private static final String IDEMPOTENCY = "Idempotency-Key";

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService payments;

    private final List<String> stores = new ArrayList<>();
    private final List<UUID> guests = new ArrayList<>();
    private String store;

    @BeforeEach
    void initializeStore() {
        store = newStore();
    }

    @AfterEach
    void removeOnlyOperatorFixtures() {
        for (String fixtureStore : stores) {
            jdbc.sql("DELETE FROM pickup_schedule_publications WHERE store_id = ?").param(fixtureStore).update();
            jdbc.sql("DELETE FROM operator_availability_events WHERE store_id = ?").param(fixtureStore).update();
            jdbc.sql("DELETE FROM operator_order_events WHERE store_id = ?").param(fixtureStore).update();
            jdbc.sql("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operator_accounts WHERE store_id = ?)")
                    .param(fixtureStore).update();
            jdbc.sql("DELETE FROM operator_accounts WHERE store_id = ?").param(fixtureStore).update();
            jdbc.sql("""
                    DELETE FROM payment_exceptions WHERE attempt_id IN (
                        SELECT p.id FROM payment_attempts p JOIN orders o ON o.id = p.order_id WHERE o.store_id = ?
                    )
                    """).param(fixtureStore).update();
            jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
                    .param(fixtureStore).update();
            for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
                jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(fixtureStore).update();
            }
            jdbc.sql("DELETE FROM stores WHERE id = ?").param(fixtureStore).update();
        }
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void queueContainsOnlyPaidOrdersFromTheOperatorStoreAndOmitsCustomerAndPaymentData() throws Exception {
        Staff kitchen = newStaff(store, "kitchen");
        String staffBearer = login(kitchen);
        OrderFixture accepted = newOrder(store, true);
        OrderFixture unpaid = newOrder(store, false);
        OrderFixture differentStore = newOrder(newStore(), true);

        api.perform(get(OPERATOR + "/orders")).andExpect(status().isUnauthorized());
        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, accepted.guestBearer()))
                .andExpect(status().isUnauthorized());
        JsonNode queue = body(api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, staffBearer))
                .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));

        assertThat(keys(queue)).containsExactlyInAnyOrder("orders", "serverTime");
        assertThat(queue.path("orders").size()).isEqualTo(1);
        JsonNode visible = queue.path("orders").get(0);
        assertThat(visible.path("id").asString("")).isEqualTo(accepted.orderId());
        assertThat(visible.path("status").asString("")).isEqualTo("accepted");
        assertThat(visible.path("paymentStatus").asString("")).isEqualTo("paid");
        assertThat(keys(visible)).containsExactlyInAnyOrder("id", "status", "paymentStatus", "lines", "pickupStartsAt",
                "pickupEndsAt", "acceptedAt");
        assertThat(Instant.parse(queue.path("serverTime").asString()))
                .isAfterOrEqualTo(Instant.parse(visible.path("acceptedAt").asString()));
        assertThat(keys(visible.path("lines").get(0))).containsExactlyInAnyOrder("sku", "modifierIds", "quantity");
        change(staffBearer, differentStore.orderId(), "preparing", null).andExpect(status().isNotFound());
        change(staffBearer, unpaid.orderId(), "preparing", null).andExpect(status().isNotFound());
    }

    @Test
    void counterLookupReportsPickupProgressWithoutChangingCollection() throws Exception {
        String pickup = login(newStaff(store, "pickup"));
        String manager = login(newStaff(store, "manager"));
        OrderFixture order = newOrder(store, true);
        UUID id = UUID.fromString(order.orderId());
        String code = order.orderId().substring(28).toUpperCase(Locale.ROOT);

        JsonNode found = body(counterLookup(pickup, code).andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(keys(found)).containsExactlyInAnyOrder("orderId", "status", "pickupStartsAt", "pickupEndsAt");
        assertThat(found.path("orderId").asString()).isEqualTo(order.orderId());
        assertThat(found.path("status").asString()).isEqualTo("accepted");
        assertThat(Instant.parse(found.path("pickupStartsAt").asString())).isEqualTo(jdbc.sql(
                "SELECT pickup_starts_at FROM orders WHERE id = ?").param(id).query(OffsetDateTime.class).single().toInstant());
        assertThat(Instant.parse(found.path("pickupEndsAt").asString())).isEqualTo(jdbc.sql(
                "SELECT pickup_ends_at FROM orders WHERE id = ?").param(id).query(OffsetDateTime.class).single().toInstant());
        assertThat(jdbc.sql("SELECT count(*) FROM operator_order_events WHERE order_id = ?")
                .param(id).query(Long.class).single()).isZero();

        change(manager, order.orderId(), "preparing", null).andExpect(status().isOk());
        counterLookup(manager, order.orderId().toUpperCase(Locale.ROOT)).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("preparing"));
        change(manager, order.orderId(), "ready", null).andExpect(status().isOk());
        counterLookup(pickup, code).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ready"));
        assertThat(jdbc.sql("SELECT status = 'ready' AND payment_status = 'paid' AND pickup_code = ? FROM orders WHERE id = ?")
                .params(order.code(), id).query(Boolean.class).single()).isTrue();
        assertThat(jdbc.sql("SELECT count(*) FROM operator_order_events WHERE order_id = ?")
                .param(id).query(Long.class).single()).isEqualTo(2);
        change(pickup, order.orderId(), "collected", null).andExpect(status().isBadRequest());
        change(pickup, order.orderId(), "collected", order.code()).andExpect(status().isOk());
        counterLookup(pickup, code).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("collected"));
        assertPickupStatus(pickup, order.orderId(), "collected", true);
        assertThat(jdbc.sql("SELECT count(*) FROM operator_order_events WHERE order_id = ?")
                .param(id).query(Long.class).single()).isEqualTo(3);
    }

    @Test
    void counterLookupRequiresItsOwnPickupOrManagerSessionAndRejectsAmbiguousShortCodes() throws Exception {
        String foreign = newStore();
        String pickup = login(newStaff(store, "pickup"));
        String manager = login(newStaff(store, "manager"));
        String kitchen = login(newStaff(store, "kitchen"));
        String code = "D0E1F234";
        OrderFixture paid = newOrder(store, true, UUID.fromString("10000000-0000-4000-8000-0000d0e1f234"));
        OrderFixture unpaid = newOrder(store, false, UUID.fromString("20000000-0000-4000-8000-0000d0e1f234"));
        OrderFixture elsewhere = newOrder(foreign, true, UUID.fromString("30000000-0000-4000-8000-0000d0e1f234"));
        OrderFixture cancelled = newOrder(store, true, UUID.fromString("40000000-0000-4000-8000-0000d0e1f234"));
        cancel(manager, cancelled.orderId()).andExpect(status().isOk());

        counterLookup(pickup, code).andExpect(status().isOk()).andExpect(jsonPath("$.orderId").value(paid.orderId()));
        api.perform(get(OPERATOR + "/orders/lookup").queryParam("orderCode", code)).andExpect(status().isUnauthorized());
        counterLookup(paid.guestBearer(), code).andExpect(status().isUnauthorized());
        counterLookup(kitchen, code).andExpect(status().isForbidden());
        for (String missing : List.of("00000000", unpaid.orderId(), elsewhere.orderId(), cancelled.orderId())) {
            counterLookup(manager, missing).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not_found"));
        }
        for (String invalid : List.of("", "#" + code, "D0E1F23", code + 'F', "d0e1f23g", "00000000-0000-0000-0000-00000000000z")) {
            counterLookup(manager, invalid).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_input"));
        }
        api.perform(get(OPERATOR + "/orders/lookup").header(HttpHeaders.AUTHORIZATION, manager)).andExpect(status().isBadRequest());
        api.perform(get(OPERATOR + "/orders/lookup").queryParam("orderCode", code, code)
                .header(HttpHeaders.AUTHORIZATION, manager)).andExpect(status().isBadRequest());

        OrderFixture collision = newOrder(store, true, UUID.fromString("50000000-0000-4000-8000-0000d0e1f234"));
        counterLookup(pickup, code).andExpect(status().isConflict()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.code").value("order_code_ambiguous"));
        for (OrderFixture match : List.of(paid, collision)) {
            counterLookup(manager, match.orderId()).andExpect(status().isOk()).andExpect(jsonPath("$.orderId").value(match.orderId()));
        }
        api.perform(delete(OPERATOR + "/sessions/current").header(HttpHeaders.AUTHORIZATION, pickup)).andExpect(status().isNoContent());
        counterLookup(pickup, paid.orderId()).andExpect(status().isUnauthorized());
    }

    @Test
    void kitchenAcceptanceUsesTheFirstSuccessfulCurrentSettlementTimeAndKeepsItThroughTransitions() throws Exception {
        String manager = login(newStaff(store, "manager"));
        OrderFixture order = newOrder(store, false);
        UUID id = UUID.fromString(order.orderId());
        jdbc.sql("UPDATE orders SET created_at = clock_timestamp() - interval '10 minutes' WHERE id = ?").param(id).update();

        String oldAttempt = beginPayment(order.guestBearer(), order.orderId());
        api.perform(post(API + "/local/orders/" + id + "/payments/" + oldAttempt + "/result")
                .header(HttpHeaders.AUTHORIZATION, order.guestBearer()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"declined\"}")).andExpect(status().isOk());
        String primaryAttempt = body(api.perform(post(API + "/orders/" + id + "/payments")
                .header(HttpHeaders.AUTHORIZATION, order.guestBearer()).header(IDEMPOTENCY, "second-payment"))
                .andExpect(status().isOk())).path("id").asString();
        VerifiedPayment superseded = new VerifiedPayment(oldAttempt, "synthetic-earlier-charge", 9700, "RWF", PaymentResult.PAID);
        payments.settlePayment(superseded);
        assertThat(jdbc.sql("SELECT accepted_at IS NULL FROM orders WHERE id = ?").param(id).query(Boolean.class).single()).isTrue();
        JsonNode before = body(api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, manager))
                .andExpect(status().isOk()).andExpect(jsonPath("$.orders").isEmpty()));
        Instant beforeSettlement = Instant.parse(before.path("serverTime").asString());

        VerifiedPayment primary = new VerifiedPayment(primaryAttempt, "synthetic-current-charge", 9700, "RWF", PaymentResult.PAID);
        payments.settlePayment(primary);
        JsonNode after = body(api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, manager))
                .andExpect(status().isOk()).andExpect(jsonPath("$.orders[0].id").value(order.orderId())));
        Instant accepted = Instant.parse(after.path("orders").get(0).path("acceptedAt").asString());
        Instant afterSettlement = Instant.parse(after.path("serverTime").asString());
        assertThat(accepted).isBetween(beforeSettlement, afterSettlement);
        assertThat(jdbc.sql("SELECT accepted_at FROM orders WHERE id = ?").param(id)
                .query(OffsetDateTime.class).single().toInstant()).isEqualTo(accepted);
        api.perform(get(API + "/orders/" + id).header(HttpHeaders.AUTHORIZATION, order.guestBearer()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.acceptedAt").doesNotHaveJsonPath());

        payments.settlePayment(primary);
        payments.settlePayment(superseded);
        payments.settlePayment(new VerifiedPayment(primaryAttempt, "synthetic-duplicate-charge", 9700, "RWF", PaymentResult.PAID));
        String acceptedAt = after.path("orders").get(0).path("acceptedAt").asString();
        change(manager, order.orderId(), "preparing", null).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedAt").value(acceptedAt));
        change(manager, order.orderId(), "ready", null).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedAt").value(acceptedAt));
        cancel(manager, order.orderId()).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedAt").value(acceptedAt));
        cancel(manager, order.orderId()).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedAt").value(acceptedAt));
    }

    @Test
    void legacyAcceptedOrderRemainsVisibleWithNullTimeAndCanStillBeAcknowledged() throws Exception {
        String kitchen = login(newStaff(store, "kitchen"));
        OrderFixture legacy = newOrder(store, true);
        jdbc.sql("UPDATE orders SET accepted_at = NULL WHERE id = ?").param(UUID.fromString(legacy.orderId())).update();

        JsonNode queue = body(api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, kitchen))
                .andExpect(status().isOk()).andExpect(jsonPath("$.orders[0].id").value(legacy.orderId())));
        assertThat(queue.path("orders").get(0).path("acceptedAt").isNull()).isTrue();
        assertThat(body(change(kitchen, legacy.orderId(), "preparing", null).andExpect(status().isOk()))
                .path("acceptedAt").isNull()).isTrue();
    }

    @Test
    void managersSeeOnlyTheirStoresLatestPaymentExceptionsWithoutGuestData() throws Exception {
        String foreignStore = newStore();
        String ownManager = login(newStaff(store, "manager"));
        String foreignManager = login(newStaff(foreignStore, "manager"));
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        OrderFixture ownPaid = newOrder(store, true);
        OrderFixture ownLate = newOrder(store, false);
        OrderFixture foreignPaid = newOrder(foreignStore, true);
        String ownDuplicateReference = paymentReference(ownPaid);
        String lateReference = beginPayment(ownLate.guestBearer(), ownLate.orderId());
        String foreignReference = paymentReference(foreignPaid);

        payments.settlePayment(new VerifiedPayment(ownDuplicateReference, "synthetic-own-duplicate", 9700, "RWF", PaymentResult.PAID));
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() - interval '1 second' WHERE id = ?")
                .param(UUID.fromString(ownLate.orderId())).update();
        payments.settlePayment(new VerifiedPayment(lateReference, "synthetic-own-late", 9700, "RWF", PaymentResult.PAID));
        assertThat(jdbc.sql("SELECT accepted_at IS NULL FROM orders WHERE id = ?")
                .param(UUID.fromString(ownLate.orderId())).query(Boolean.class).single()).isTrue();
        payments.settlePayment(new VerifiedPayment(foreignReference, "synthetic-foreign-duplicate", 9700, "RWF", PaymentResult.PAID));
        jdbc.sql("UPDATE payment_exceptions SET created_at = now() - interval '5 minutes' WHERE attempt_id = ?")
                .param(UUID.fromString(ownDuplicateReference)).update();

        paymentExceptions(ownPaid.guestBearer()).andExpect(status().isUnauthorized());
        for (String denied : List.of(kitchen, pickup)) {
            paymentExceptions(denied).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
        }
        paymentExceptions(foreignManager).andExpect(status().isOk()).andExpect(jsonPath("$.exceptions.length()").value(1))
                .andExpect(jsonPath("$.exceptions[0].providerTransactionId").value("synthetic-foreign-duplicate"));

        JsonNode review = body(paymentExceptions(ownManager).andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(keys(review)).containsExactly("exceptions");
        JsonNode visible = review.path("exceptions");
        assertThat(visible.size()).isEqualTo(2);
        assertPaymentException(visible.get(0), ownLate.orderId(), lateReference, "synthetic-own-late", "unavailable_reservation");
        assertPaymentException(visible.get(1), ownPaid.orderId(), ownDuplicateReference, "synthetic-own-duplicate", "duplicate_transaction");

        jdbc.sql("""
                INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at)
                SELECT ?, 'synthetic-recent-' || ordinal, 'duplicate_transaction', now() + ordinal * interval '1 second'
                FROM generate_series(1, 51) AS fixtures(ordinal)
                """).param(UUID.fromString(ownDuplicateReference)).update();
        paymentExceptions(ownManager).andExpect(status().isOk()).andExpect(jsonPath("$.exceptions.length()").value(50))
                .andExpect(jsonPath("$.exceptions[0].providerTransactionId").value("synthetic-recent-51"))
                .andExpect(jsonPath("$.exceptions[49].providerTransactionId").value("synthetic-recent-2"));
    }

    private static void assertPaymentException(JsonNode entry, String orderId, String reference, String transaction, String reason) {
        assertThat(keys(entry)).containsExactlyInAnyOrder("orderId", "merchantReference", "providerTransactionId", "reason", "createdAt");
        assertThat(entry.path("orderId").asString("")).isEqualTo(orderId);
        assertThat(entry.path("merchantReference").asString("")).isEqualTo(reference);
        assertThat(entry.path("providerTransactionId").asString("")).isEqualTo(transaction);
        assertThat(entry.path("reason").asString("")).isEqualTo(reason);
        assertThat(entry.path("createdAt").isString()).isTrue();
    }

    private ResultActions paymentExceptions(String bearer) throws Exception {
        return api.perform(get(OPERATOR + "/payment-exceptions").header(HttpHeaders.AUTHORIZATION, bearer));
    }

    private String paymentReference(OrderFixture order) {
        return jdbc.sql("SELECT id FROM payment_attempts WHERE order_id = ?")
                .param(UUID.fromString(order.orderId())).query(UUID.class).single().toString();
    }

    @Test
    void readyTransitionQueuesConsentedPickupAlertsOnce() throws Exception {
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        OrderFixture order = newOrder(store, true);
        UUID orderId = UUID.fromString(order.orderId());
        UUID optedIn = UUID.randomUUID();
        UUID revoked = UUID.randomUUID();
        jdbc.sql("""
                INSERT INTO pickup_alerts (id, order_id, guest_session_id, installation_id, locale,
                    enabled, state, encrypted_token)
                SELECT ?, id, guest_session_id, ?, 'en', true, 'waiting', ? FROM orders WHERE id = ?
                """).params(optedIn, UUID.randomUUID(), new byte[64], orderId).update();
        jdbc.sql("""
                INSERT INTO pickup_alerts (id, order_id, guest_session_id, installation_id, locale,
                    enabled, state)
                SELECT ?, id, guest_session_id, ?, 'rw', false, 'cancelled' FROM orders WHERE id = ?
                """).params(revoked, UUID.randomUUID(), orderId).update();

        change(kitchen, order.orderId(), "preparing", null).andExpect(status().isOk());
        change(pickup, order.orderId(), "ready", null).andExpect(status().isForbidden());
        String stateQuery = "SELECT state FROM pickup_alerts WHERE id = ?";
        String queuedQuery = "SELECT queued_at FROM pickup_alerts WHERE id = ?";
        assertThat(jdbc.sql(stateQuery).param(optedIn).query(String.class).single()).isEqualTo("waiting");

        change(kitchen, order.orderId(), "ready", null).andExpect(status().isOk());
        OffsetDateTime queued = jdbc.sql(queuedQuery).param(optedIn).query(OffsetDateTime.class).single();
        assertThat(queued).isNotNull();
        assertThat(jdbc.sql(stateQuery).param(optedIn).query(String.class).single()).isEqualTo("pending");
        assertThat(jdbc.sql(stateQuery).param(revoked).query(String.class).single()).isEqualTo("cancelled");
        change(kitchen, order.orderId(), "ready", null).andExpect(status().isConflict());
        assertThat(jdbc.sql(queuedQuery).param(optedIn).query(OffsetDateTime.class).single()).isEqualTo(queued);
    }

    @Test
    void managerCancellationReleasesCapacityAndSurvivesPrimaryAndDuplicateSettlementReplays() throws Exception {
        Staff manager = newStaff(store, "manager");
        String managerBearer = login(manager);
        jdbc.sql("UPDATE pickup_slots SET capacity = 1 WHERE store_id = ?").param(store).update();
        OrderFixture paid = newOrder(store, true);
        UUID id = UUID.fromString(paid.orderId());
        UUID attempt = UUID.fromString(paymentReference(paid));
        String primary = "local-" + attempt;
        String guest = newGuest();
        quote(guest, store).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("slot_unavailable"));

        for (String state : List.of("waiting", "pending", "sending", "receipt_pending")) {
            jdbc.sql("""
                    INSERT INTO pickup_alerts (id, order_id, guest_session_id, installation_id, locale, enabled, state,
                        encrypted_token, queued_at, next_attempt_at, lease_id, lease_until, expo_ticket_id)
                    SELECT ?, id, guest_session_id, ?, 'en', true, ?, ?, now(), now(), ?, now() + interval '1 minute', ?
                    FROM orders WHERE id = ?
                    """).params(UUID.randomUUID(), UUID.randomUUID(), state, new byte[64], UUID.randomUUID(),
                            state.equals("receipt_pending") ? "accepted-ticket" : null, id).update();
        }

        cancel(managerBearer, paid.orderId()).andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.id").value(paid.orderId())).andExpect(jsonPath("$.status").value("cancelled"))
                .andExpect(jsonPath("$.paymentStatus").value("refund_pending"));
        quote(guest, store).andExpect(status().isOk());
        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, managerBearer))
                .andExpect(status().isOk()).andExpect(jsonPath("$.orders").isEmpty());
        assertThat(jdbc.sql("""
                SELECT count(*) FROM pickup_alerts WHERE order_id = ? AND state = 'cancelled'
                    AND NOT enabled AND encrypted_token IS NULL AND lease_id IS NULL AND lease_until IS NULL
                    AND expo_ticket_id IS NULL AND next_attempt_at IS NULL
                """).param(id).query(Long.class).single()).isEqualTo(3);
        assertThat(jdbc.sql("SELECT state FROM pickup_alerts WHERE order_id = ? AND expo_ticket_id = 'accepted-ticket'")
                .param(id).query(String.class).single()).isEqualTo("receipt_pending");

        payments.settlePayment(new VerifiedPayment(attempt.toString(), primary, 9700, "RWF", PaymentResult.PAID));
        payments.settlePayment(new VerifiedPayment(attempt.toString(), "synthetic-after-cancel", 9700, "RWF", PaymentResult.PAID));
        cancel(managerBearer, paid.orderId()).andExpect(status().isOk())
                .andExpect(jsonPath("$.paymentStatus").value("refund_pending"));
        api.perform(get(API + "/orders/" + id).header(HttpHeaders.AUTHORIZATION, paid.guestBearer()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"))
                .andExpect(jsonPath("$.paymentStatus").value("refund_pending")).andExpect(jsonPath("$.pickupCode").doesNotExist());
        assertThat(jdbc.sql("""
                SELECT status || ':' || provider_transaction_id FROM payment_attempts WHERE id = ?
                """).param(attempt).query(String.class).single()).isEqualTo("paid:" + primary);
        assertThat(jdbc.sql("""
                SELECT provider_transaction_id || ':' || reason FROM payment_exceptions WHERE attempt_id = ?
                """).param(attempt).query(String.class).list())
                .containsExactlyInAnyOrder(primary + ":restaurant_cancelled", "synthetic-after-cancel:duplicate_transaction");
        assertThat(jdbc.sql("""
                SELECT operator_id::text || ':' || previous_status FROM operator_order_events
                WHERE order_id = ? AND requested_status = 'cancelled'
                """).param(id).query(String.class).single()).isEqualTo(manager.id() + ":accepted");
    }

    @Test
    void cancellationRequiresTheSameStoreManagerAndAnUncollectedPaidOrder() throws Exception {
        String manager = login(newStaff(store, "manager"));
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        String otherStore = newStore();
        OrderFixture paid = newOrder(store, true);
        OrderFixture unpaid = newOrder(store, false);
        OrderFixture foreignPaid = newOrder(otherStore, true);

        api.perform(post(OPERATOR + "/orders/" + paid.orderId() + "/cancel")).andExpect(status().isUnauthorized());
        cancel(paid.guestBearer(), paid.orderId()).andExpect(status().isUnauthorized());
        cancel(kitchen, paid.orderId()).andExpect(status().isForbidden());
        cancel(pickup, paid.orderId()).andExpect(status().isForbidden());
        cancel(manager, foreignPaid.orderId()).andExpect(status().isNotFound());
        cancel(manager, unpaid.orderId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("invalid_transition"));

        String lateAttempt = beginPayment(unpaid.guestBearer(), unpaid.orderId());
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() - interval '1 second' WHERE id = ?")
                .param(UUID.fromString(unpaid.orderId())).update();
        payments.settlePayment(new VerifiedPayment(lateAttempt, "synthetic-late-before-cancel", 9700, "RWF", PaymentResult.PAID));
        cancel(manager, unpaid.orderId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("invalid_transition"));
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
                .param(UUID.fromString(lateAttempt)).query(String.class).single()).isEqualTo("unavailable_reservation");

        change(kitchen, paid.orderId(), "preparing", null).andExpect(status().isOk());
        change(kitchen, paid.orderId(), "ready", null).andExpect(status().isOk());
        change(pickup, paid.orderId(), "collected", paid.code()).andExpect(status().isOk());
        cancel(manager, paid.orderId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("invalid_transition"));
    }

    @Test
    void unavailableOrAmbiguousPrimaryPaymentFailsClosed() throws Exception {
        String manager = login(newStaff(store, "manager"));
        OrderFixture paid = newOrder(store, true);
        UUID id = UUID.fromString(paid.orderId());
        UUID primary = UUID.fromString(paymentReference(paid));
        String primaryTransaction = "local-" + primary;
        jdbc.sql("UPDATE payment_attempts SET provider_transaction_id = NULL WHERE id = ?").param(primary).update();
        cancel(manager, paid.orderId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("payment_reference_unavailable"));
        jdbc.sql("UPDATE payment_attempts SET provider_transaction_id = ? WHERE id = ?")
                .params(primaryTransaction, primary).update();

        UUID older = UUID.randomUUID();
        String olderTransaction = "synthetic-earlier-paid";
        jdbc.sql("""
                INSERT INTO payment_attempts (id, order_id, sequence, request_key, status, provider_transaction_id)
                    OVERRIDING SYSTEM VALUE VALUES (?, ?, 0, 'earlier-payment', 'paid', ?)
                """).params(older, id, olderTransaction).update();
        cancel(manager, paid.orderId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("payment_reference_unavailable"));
        assertThat(jdbc.sql("SELECT count(*) FROM payment_exceptions WHERE attempt_id IN (?, ?)")
                .params(primary, older).query(Long.class).single()).isZero();
        jdbc.sql("""
                INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at)
                VALUES (?, ?, 'superseded_attempt', now()), (?, ?, 'unavailable_reservation', now())
                """).params(older, olderTransaction, primary, primaryTransaction).update();
        cancel(manager, paid.orderId()).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("payment_reference_unavailable"));
        assertThat(jdbc.sql("SELECT status || ':' || payment_status FROM orders WHERE id = ?")
                .param(id).query(String.class).single()).isEqualTo("accepted:paid");
        assertThat(jdbc.sql("SELECT count(*) FROM operator_order_events WHERE order_id = ?")
                .param(id).query(Long.class).single()).isZero();

        jdbc.sql("DELETE FROM payment_exceptions WHERE attempt_id = ?").param(primary).update();
        cancel(manager, paid.orderId()).andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("refund_pending"));
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
                .param(older).query(String.class).single()).isEqualTo("superseded_attempt");
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
                .param(primary).query(String.class).single()).isEqualTo("restaurant_cancelled");
    }

    @Test
    void concurrentCancellationAndCollectionHaveOnlyOneWinner() throws Exception {
        String manager = login(newStaff(store, "manager"));
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        OrderFixture paid = newOrder(store, true);
        UUID id = UUID.fromString(paid.orderId());
        UUID attemptId = UUID.fromString(paymentReference(paid));
        change(kitchen, paid.orderId(), "preparing", null).andExpect(status().isOk());
        change(kitchen, paid.orderId(), "ready", null).andExpect(status().isOk());
        var waiting = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        int cancelled;
        int collected;
        try (var threads = Executors.newFixedThreadPool(2)) {
            var cancel = threads.submit(() -> {
                waiting.countDown();
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Cancellation start barrier timed out");
                return cancel(manager, paid.orderId()).andReturn().getResponse().getStatus();
            });
            var collect = threads.submit(() -> collectAfterBarrier(waiting, start, pickup, paid));
            assertThat(waiting.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            cancelled = cancel.get(10, TimeUnit.SECONDS);
            collected = collect.get(10, TimeUnit.SECONDS);
        }
        String saved = jdbc.sql("SELECT status || ':' || payment_status FROM orders WHERE id = ?")
                .param(id).query(String.class).single();
        String audited = jdbc.sql("""
                SELECT requested_status FROM operator_order_events
                WHERE order_id = ? AND requested_status IN ('collected', 'cancelled')
                """).param(id).query(String.class).single();
        List<String> exceptions = jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
                .param(attemptId).query(String.class).list();
        if (cancelled == 200) {
            assertThat(collected).isEqualTo(404);
            assertThat(saved).isEqualTo("cancelled:refund_pending");
            assertThat(audited).isEqualTo("cancelled");
            assertThat(exceptions).containsExactly("restaurant_cancelled");
        } else {
            assertThat(cancelled).isEqualTo(409);
            assertThat(collected).isEqualTo(200);
            assertThat(saved).isEqualTo("collected:paid");
            assertThat(audited).isEqualTo("collected");
            assertThat(exceptions).isEmpty();
        }
    }

    @Test
    void transitionsAreRoleBoundAndConcurrentHandoffChangesTheOrderOnce() throws Exception {
        Staff kitchen = newStaff(store, "kitchen");
        Staff pickup = newStaff(store, "pickup");
        String kitchenBearer = login(kitchen);
        String pickupBearer = login(pickup);
        OrderFixture order = newOrder(store, true);

        change(pickupBearer, order.orderId(), "preparing", null).andExpect(status().isForbidden());
        change(kitchenBearer, order.orderId(), "ready", null).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("invalid_transition"));
        change(kitchenBearer, order.orderId(), "preparing", null).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("preparing"));
        change(kitchenBearer, order.orderId(), "ready", null).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ready"));
        change(kitchenBearer, order.orderId(), "collected", order.code()).andExpect(status().isForbidden());
        change(pickupBearer, order.orderId(), "collected", "12").andExpect(status().isBadRequest());

        var waiting = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var threads = Executors.newFixedThreadPool(2)) {
            var first = threads.submit(() -> collectAfterBarrier(waiting, start, pickupBearer, order));
            var second = threads.submit(() -> collectAfterBarrier(waiting, start, pickupBearer, order));
            assertThat(waiting.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(200, 409);
        }

        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, pickupBearer))
                .andExpect(status().isOk()).andExpect(jsonPath("$.orders").isEmpty());
        api.perform(get(API + "/orders/" + order.orderId()).header(HttpHeaders.AUTHORIZATION, order.guestBearer()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("collected"))
                .andExpect(jsonPath("$.pickupCode").doesNotExist());
        assertThat(jdbc.sql("""
                SELECT operator_id::text || ':' || requested_status FROM operator_order_events
                WHERE order_id = ? AND outcome = 'changed' ORDER BY id
                """).param(UUID.fromString(order.orderId())).query(String.class).list())
                .containsExactly(kitchen.id() + ":preparing", kitchen.id() + ":ready", pickup.id() + ":collected");
    }

    @Test
    void pickupStatusDistinguishesReadyCancelledAndCollectionByTheSignedInOperator() throws Exception {
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        String manager = login(newStaff(store, "manager"));
        OrderFixture collected = newOrder(store, true);
        OrderFixture cancelled = newOrder(store, true);

        change(kitchen, collected.orderId(), "preparing", null).andExpect(status().isOk());
        change(kitchen, collected.orderId(), "ready", null).andExpect(status().isOk());
        assertPickupStatus(pickup, collected.orderId(), "ready", false);

        change(pickup, collected.orderId(), "collected", collected.code()).andExpect(status().isOk());
        assertPickupStatus(pickup, collected.orderId(), "collected", true);
        assertPickupStatus(manager, collected.orderId(), "collected", false);
        assertThat(jdbc.sql("""
                SELECT count(*) FROM operator_order_events
                WHERE order_id = ? AND requested_status = 'collected' AND outcome = 'changed'
                """).param(UUID.fromString(collected.orderId())).query(Long.class).single()).isOne();

        cancel(manager, cancelled.orderId()).andExpect(status().isOk());
        assertPickupStatus(pickup, cancelled.orderId(), "cancelled", false);
    }

    @Test
    void pickupStatusRequiresAuthorizedStaffAndDoesNotExposeOrdersAtAnotherStore() throws Exception {
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        String manager = login(newStaff(store, "manager"));
        OrderFixture homeOrder = newOrder(store, true);
        OrderFixture foreignOrder = newOrder(newStore(), true);

        api.perform(get(OPERATOR + "/orders/{id}/pickup-status", homeOrder.orderId()))
                .andExpect(status().isUnauthorized()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
        pickupStatus(homeOrder.guestBearer(), homeOrder.orderId()).andExpect(status().isUnauthorized());
        pickupStatus(kitchen, homeOrder.orderId()).andExpect(status().isForbidden());
        pickupStatus(pickup, foreignOrder.orderId()).andExpect(status().isNotFound())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
        pickupStatus(manager, foreignOrder.orderId()).andExpect(status().isNotFound());
        pickupStatus(manager, UUID.randomUUID().toString()).andExpect(status().isNotFound());
        pickupStatus(pickup, "invalid").andExpect(status().isNotFound());
    }

    @Test
    void wrongPickupCodeIsAuditedAndThrottledWithoutRecordingTheCode() throws Exception {
        Staff manager = newStaff(store, "manager");
        String bearer = login(manager);
        OrderFixture order = newOrder(store, true);
        change(bearer, order.orderId(), "preparing", null).andExpect(status().isOk());
        change(bearer, order.orderId(), "ready", null).andExpect(status().isOk());
        String wrongCode = "000000".equals(order.code()) ? "111111" : "000000";
        for (int attempt = 0; attempt < 5; attempt++) {
            change(bearer, order.orderId(), "collected", wrongCode).andExpect(status().isConflict())
                    .andExpect(jsonPath("$.code").value("pickup_code_mismatch"));
        }
        change(bearer, order.orderId(), "collected", order.code()).andExpect(status().isTooManyRequests());
        assertThat(jdbc.sql("""
                SELECT count(*) FROM operator_order_events
                WHERE order_id = ? AND operator_id = ? AND outcome = 'pickup_code_mismatch'
                """).params(UUID.fromString(order.orderId()), manager.id()).query(Long.class).single()).isEqualTo(5);
        jdbc.sql("UPDATE operator_order_events SET occurred_at = now() - interval '3 minutes' WHERE order_id = ?")
                .param(UUID.fromString(order.orderId())).update();
        change(bearer, order.orderId(), "collected", order.code()).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("collected"));
    }

    @Test
    void loginBackoffExpiryAndLogoutPersistWithoutStoringTheBearer() throws Exception {
        api.perform(get("/operator/index.html")).andExpect(status().isOk())
                .andExpect(header().string("Content-Security-Policy", "frame-ancestors 'none'"))
                .andExpect(header().string("X-Frame-Options", "DENY"));
        Staff staff = newStaff(store, "kitchen");
        for (int attempt = 0; attempt < 5; attempt++) {
            postLogin(staff, "incorrect").andExpect(status().isUnauthorized())
                    .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
        }
        postLogin(staff, PASSWORD).andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("rate_limited"));
        jdbc.sql("UPDATE operator_accounts SET login_blocked_until = now() - interval '1 second' WHERE id = ?")
                .param(staff.id()).update();

        String expired = login(staff);
        String tokenHash = jdbc.sql("SELECT token_hash FROM operator_sessions WHERE operator_id = ?")
                .param(staff.id()).query(String.class).single();
        assertThat(tokenHash).isEqualTo(sha256(expired.substring(7))).isNotEqualTo(expired.substring(7));
        jdbc.sql("UPDATE operator_sessions SET expires_at = now() WHERE operator_id = ?").param(staff.id()).update();
        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, expired)).andExpect(status().isUnauthorized());

        String current = login(staff);
        api.perform(delete(OPERATOR + "/sessions/current").header(HttpHeaders.AUTHORIZATION, current))
                .andExpect(status().isNoContent());
        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, current)).andExpect(status().isUnauthorized());
    }

    @Test
    void availabilityIsManagerOnlyStoreScopedAndAuditsOnlyActualChanges() throws Exception {
        Staff manager = newStaff(store, "manager");
        String bearer = login(manager);
        String staff = login(newStaff(store, "kitchen"));
        String otherStore = newStore();
        String otherManager = login(newStaff(otherStore, "manager"));
        api.perform(get(OPERATOR + "/availability")).andExpect(status().isUnauthorized());
        api.perform(get(OPERATOR + "/availability").header(HttpHeaders.AUTHORIZATION, newGuest()))
            .andExpect(status().isUnauthorized());
        api.perform(get(OPERATOR + "/availability").header(HttpHeaders.AUTHORIZATION, staff))
            .andExpect(status().isForbidden());
        updateAvailability(staff, "{}").andExpect(status().isForbidden());

        JsonNode initial = availability(bearer);
        String version = initial.path("version").asString();
        assertThat(initial.path("open").asBoolean()).isTrue();
        assertThat(initial.path("products").path(0).path("name").path("en").asString()).isEqualTo("Double Smash");
        for (String invalid : List.of(
            "{\"expectedVersion\":\"%s\",\"open\":true,\"sku\":\"double-smash\",\"available\":false}",
            "{\"expectedVersion\":\"%s\",\"open\":false,\"open\":true}",
            "{\"expectedVersion\":\"%s\",\"open\":null}",
            "{\"expectedVersion\":\"%s\",\"available\":true,\"other\":\"double-smash\"}"
        )) {
            updateAvailability(bearer, invalid.formatted(version)).andExpect(status().isBadRequest());
        }
        updateAvailability(bearer, productChange(version, "missing", false)).andExpect(status().isNotFound());
        updateAvailability(bearer, storeChange(version, true)).andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(version));
        assertThat(auditCount(store)).isZero();

        String etag = api.perform(get(API + "/stores/" + store + "/menu")).andExpect(status().isOk())
            .andReturn().getResponse().getHeader(HttpHeaders.ETAG);
        JsonNode changed = body(updateAvailability(bearer, productChange(version, "double-smash", false))
            .andExpect(status().isOk()).andExpect(jsonPath("$.products[0].available").value(false)));
        String newVersion = changed.path("version").asString();
        assertThat(newVersion).isNotEqualTo(version);
        api.perform(get(API + "/stores/" + store + "/menu").header(HttpHeaders.IF_NONE_MATCH, etag))
            .andExpect(status().isOk()).andExpect(jsonPath("$.version").value(newVersion))
            .andExpect(jsonPath("$.products[0].available").value(false));
        assertThat(availability(otherManager).path("products").path(0).path("available").asBoolean()).isTrue();
        updateAvailability(bearer, productChange(version, "double-smash", false)).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("catalog_version_conflict"));
        updateAvailability(bearer, productChange(newVersion, "double-smash", false)).andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(newVersion));
        assertThat(auditCount(store)).isEqualTo(1);
        jdbc.sql("UPDATE operator_accounts SET username = ? WHERE id = ?")
            .params("renamed-" + manager.id(), manager.id()).update();
        assertThat(jdbc.sql("""
            SELECT operator_id::text || ':' || operator_username || ':' || action || ':' || sku || ':' || previous_value || ':' || new_value
            FROM operator_availability_events WHERE store_id = ?
            """).param(store).query(String.class).single())
            .isEqualTo(manager.id() + ":" + manager.username() + ":product_available:double-smash:true:false");
        assertThatThrownBy(() -> jdbc.sql("UPDATE operator_availability_events SET new_value = true WHERE store_id = ?")
            .param(store).update()).isInstanceOf(DataAccessException.class);
    }

    @Test
    void closureAndStopListInvalidateUncommittedCheckoutButPreserveAnExistingReservationAndPayment() throws Exception {
        String bearer = login(newStaff(store, "manager"));
        OrderFixture booked = newOrder(store, false);
        String browsingGuest = newGuest();
        String quoteBeforeClosure = body(quote(browsingGuest, store).andExpect(status().isOk())).path("quoteId").asString();
        String current = availability(bearer).path("version").asString();
        String closed = body(updateAvailability(bearer, storeChange(current, false)).andExpect(status().isOk())
            .andExpect(jsonPath("$.open").value(false))).path("version").asString();

        api.perform(get(API + "/stores/" + store + "/menu")).andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(closed)).andExpect(jsonPath("$.store.open").value(false))
            .andExpect(jsonPath("$.slots[0].available").value(false));
        createOrder(browsingGuest, quoteBeforeClosure, "prior-quote").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("slot_unavailable"));
        quote(browsingGuest, store).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("slot_unavailable"));

        String attempt = beginPayment(booked.guestBearer(), booked.orderId());
        api.perform(post(API + "/local/orders/" + booked.orderId() + "/payments/" + attempt + "/result")
            .header(HttpHeaders.AUTHORIZATION, booked.guestBearer()).contentType(MediaType.APPLICATION_JSON)
            .content("{\"status\":\"paid\"}")).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("accepted")).andExpect(jsonPath("$.paymentStatus").value("paid"));

        String reopened = body(updateAvailability(bearer, storeChange(closed, true)).andExpect(status().isOk())
            .andExpect(jsonPath("$.open").value(true))).path("version").asString();
        String quoteBeforeStop = body(quote(browsingGuest, store).andExpect(status().isOk())).path("quoteId").asString();
        updateAvailability(bearer, productChange(reopened, "double-smash", false)).andExpect(status().isOk());
        createOrder(browsingGuest, quoteBeforeStop, "product-stopped").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("quote_changed"));
        quote(browsingGuest, store).andExpect(status().isOk()).andExpect(jsonPath("$.lines").isEmpty())
            .andExpect(jsonPath("$.changes[0].kind").value("unavailable"))
            .andExpect(jsonPath("$.changes[0].sku").value("double-smash"));

        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, bearer)).andExpect(status().isOk())
            .andExpect(jsonPath("$.orders[0].id").value(booked.orderId()))
            .andExpect(jsonPath("$.orders[0].paymentStatus").value("paid"));
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?")
            .param(store).query(Long.class).single()).isEqualTo(1);
        assertThat(auditCount(store)).isEqualTo(3);
    }

    @Test
    void managerSlotSnapshotsAreBoundedAndEditsAreVersionedAndScoped() throws Exception {
        Staff manager = newStaff(store, "manager");
        String bearer = login(manager);
        String kitchen = login(newStaff(store, "kitchen"));
        String foreignStore = newStore();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity) VALUES
                (?, 'expired', now() - interval '1 minute', now() + interval '5 minutes', 3),
                (?, 'foreign-only', now() + interval '5 minutes', now() + interval '10 minutes', 3)
            """).params(store, foreignStore).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            SELECT ?, 'future-' || lpad(n::text, 2, '0'), now() + (n + 60) * interval '1 minute',
                now() + (n + 70) * interval '1 minute', 5 FROM generate_series(1, 38) AS seq(n)
            """).param(store).update();

        JsonNode initial = availability(bearer);
        String version = initial.path("version").asString();
        JsonNode slots = initial.path("slots");
        assertThat(slots.size()).isEqualTo(36);
        assertThat(slots.get(0).path("id").asString()).isEqualTo(SLOT);
        assertThat(slots.get(35).path("id").asString()).isEqualTo("future-35");
        assertThat(keys(slots.get(0))).containsExactlyInAnyOrder("id", "startsAt", "endsAt", "capacity", "reserved");
        assertThat(slots.get(0).path("reserved").asInt()).isZero();
        assertThat(Instant.parse(slots.get(0).path("startsAt").asString()))
                .isBefore(Instant.parse(slots.get(0).path("endsAt").asString()));

        updateAvailability(kitchen, slotChange(version, SLOT, 1)).andExpect(status().isForbidden());
        updateAvailability(bearer, slotChange(version, "foreign-only", 1)).andExpect(status().isNotFound());
        updateAvailability(bearer, slotChange(version, "expired", 3)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("slot_update_closed"));
        for (String malformed : List.of("-1", "2147483648", "1.5", "\"1\"", "true")) {
            updateAvailability(bearer, """
                {"expectedVersion":"%s","slotId":"%s","capacity":%s}
                """.formatted(version, SLOT, malformed)).andExpect(status().isBadRequest());
        }
        updateAvailability(bearer, """
            {"expectedVersion":"%s","slotId":"%s","capacity":1,"open":true}
            """.formatted(version, SLOT)).andExpect(status().isBadRequest());
        updateAvailability(bearer, slotChange(version, SLOT, 4)).andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(version));
        assertThat(auditCount(store)).isZero();

        JsonNode published = body(updateAvailability(bearer, slotChange(version, SLOT, Integer.MAX_VALUE))
                .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.slots[0].capacity").value(Integer.MAX_VALUE)));
        String revision = published.path("version").asString();
        assertThat(revision).isNotEqualTo(version);
        updateAvailability(bearer, slotChange(version, SLOT, 1)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("catalog_version_conflict"));
        updateAvailability(bearer, slotChange(revision, SLOT, Integer.MAX_VALUE)).andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(revision));
        api.perform(get(API + "/stores/" + store + "/menu")).andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(revision));
        assertThat(jdbc.sql("""
            SELECT operator_username || ':' || previous_capacity || ':' || new_capacity FROM operator_availability_events
            WHERE store_id = ? AND operator_id = ? AND action = 'slot_capacity' AND slot_id = ?
                AND previous_version = ? AND new_version = ? AND occurred_at <= clock_timestamp()
            """).params(store, manager.id(), SLOT, version, revision).query(String.class).single())
                .isEqualTo(manager.username() + ":4:" + Integer.MAX_VALUE);
        assertThat(auditCount(store)).isOne();
    }

    @Test
    void slotCapacityIncludesPaidOrdersAndActiveHoldsThenReleasesExpiredAndCancelledPlaces() throws Exception {
        String manager = login(newStaff(store, "manager"));
        OrderFixture paid = newOrder(store, true);
        OrderFixture held = newOrder(store, false);
        JsonNode initial = availability(manager);
        String version = initial.path("version").asString();
        assertThat(initial.path("slots").get(0).path("reserved").asInt()).isEqualTo(2);
        updateAvailability(manager, slotChange(version, SLOT, 1)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("slot_capacity_below_reserved"));
        assertThat(auditCount(store)).isZero();
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() - interval '1 second' WHERE id = ?")
                .param(UUID.fromString(held.orderId())).update();

        JsonNode reduced = body(updateAvailability(manager, slotChange(version, SLOT, 1))
                .andExpect(status().isOk()).andExpect(jsonPath("$.slots[0].reserved").value(1)));
        String reducedVersion = reduced.path("version").asString();
        quote(newGuest(), store).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("slot_unavailable"));
        updateAvailability(manager, slotChange(reducedVersion, SLOT, 0)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("slot_capacity_below_reserved"));

        cancel(manager, paid.orderId()).andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("refund_pending"));
        updateAvailability(manager, slotChange(reducedVersion, SLOT, 0)).andExpect(status().isOk())
                .andExpect(jsonPath("$.slots[0].capacity").value(0)).andExpect(jsonPath("$.slots[0].reserved").value(0));
        assertThat(auditCount(store)).isEqualTo(2);
    }

    @Test
    void lastSlotReservationAndCapacityReductionCannotBothSucceed() throws Exception {
        String manager = login(newStaff(store, "manager"));
        jdbc.sql("UPDATE pickup_slots SET capacity = 1 WHERE store_id = ? AND id = ?").params(store, SLOT).update();
        String version = availability(manager).path("version").asString();
        String guest = newGuest();
        String quoteId = body(quote(guest, store).andExpect(status().isOk())).path("quoteId").asString();
        var start = new CountDownLatch(1);
        int edited;
        int booked;
        try (var threads = Executors.newFixedThreadPool(2)) {
            var edit = threads.submit(() -> {
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Capacity edit barrier timed out");
                return updateAvailability(manager, slotChange(version, SLOT, 0)).andReturn().getResponse().getStatus();
            });
            var book = threads.submit(() -> {
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Reservation barrier timed out");
                return createOrder(guest, quoteId, "last-slot").andReturn().getResponse().getStatus();
            });
            start.countDown();
            edited = edit.get(10, TimeUnit.SECONDS);
            booked = book.get(10, TimeUnit.SECONDS);
        }
        JsonNode saved = availability(manager).path("slots").get(0);
        assertThat(List.of(edited, booked)).containsExactlyInAnyOrder(200, 409);
        assertThat(saved.path("capacity").asInt()).isEqualTo(booked == 200 ? 1 : 0);
        assertThat(saved.path("reserved").asInt()).isEqualTo(booked == 200 ? 1 : 0);
        assertThat(auditCount(store)).isEqualTo(edited == 200 ? 1 : 0);
    }

    @Test
    void concurrentAvailabilityEditsWithOneCatalogVersionCannotOverwriteEachOther() throws Exception {
        String first = login(newStaff(store, "manager"));
        String second = login(newStaff(store, "manager"));
        String version = availability(first).path("version").asString();
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var close = pool.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                return updateAvailability(first, storeChange(version, false)).andReturn().getResponse().getStatus();
            });
            var stop = pool.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                return updateAvailability(second, productChange(version, "double-smash", false)).andReturn().getResponse().getStatus();
            });
            start.countDown();
            assertThat(List.of(close.get(5, TimeUnit.SECONDS), stop.get(5, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(200, 409);
        }
        JsonNode result = availability(first);
        assertThat(result.path("open").asBoolean()).isNotEqualTo(result.path("products").path(0).path("available").asBoolean());
        assertThat(auditCount(store)).isEqualTo(1);
    }

    @Test
    void managerPublishesKigaliWindowsAndTheCustomerCanReserveOne() throws Exception {
        jdbc.sql("""
                UPDATE pickup_slots SET starts_at = now() - interval '30 minutes',
                    ends_at = now() - interval '20 minutes' WHERE store_id = ?
                """).param(store).update();
        Staff staff = newStaff(store, "manager");
        String manager = login(staff);
        String kitchen = login(newStaff(store, "kitchen"));
        String pickup = login(newStaff(store, "pickup"));
        String other = newStore();
        String otherManager = login(newStaff(other, "manager"));
        LocalDate date = tomorrowInKigali();
        UUID shiftId = UUID.randomUUID();
        String version = availability(manager).path("version").asString();
        String change = scheduleChange(version, shiftId, date, "11:30", "12:00", 3);

        api.perform(get(API + "/stores/{id}/menu", store)).andExpect(status().isOk())
                .andExpect(jsonPath("$.slots").isEmpty());
        api.perform(patch(OPERATOR + "/availability").contentType(MediaType.APPLICATION_JSON).content(change))
                .andExpect(status().isUnauthorized());
        updateAvailability(kitchen, change).andExpect(status().isForbidden());
        updateAvailability(pickup, change).andExpect(status().isForbidden());
        updateAvailability(otherManager, scheduleChange(availability(otherManager).path("version").asString(),
                shiftId, date, "11:30", "12:00", 2)).andExpect(status().isOk());

        String firstSlot = "shift-" + shiftId + "-1";
        JsonNode published = body(updateAvailability(manager, change).andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.open").value(true)).andExpect(jsonPath("$.slots.length()").value(3))
                .andExpect(jsonPath("$.slots[0].id").value(firstSlot))
                .andExpect(jsonPath("$.slots[0].startsAt").value(date + "T09:30:00Z"))
                .andExpect(jsonPath("$.slots[2].endsAt").value(date + "T10:00:00Z")));
        String revision = published.path("version").asString();
        assertThat(revision).isNotEqualTo(version);
        api.perform(get(API + "/stores/{id}/menu", store)).andExpect(status().isOk())
                .andExpect(jsonPath("$.slots[0].id").value(firstSlot))
                .andExpect(jsonPath("$.slots[0].available").value(true));
        String guest = newGuest();
        String quoteId = body(quote(guest, store, firstSlot).andExpect(status().isOk())).path("quoteId").asString();
        String orderId = body(createOrder(guest, quoteId, "first-shift-order")
                .andExpect(status().isOk()).andExpect(jsonPath("$.slotId").value(firstSlot))).path("id").asString();
        assertThat(availability(manager).path("slots").get(0).path("reserved").asInt()).isEqualTo(1);

        String current = body(updateAvailability(manager, storeChange(revision, false)).andExpect(status().isOk()))
                .path("version").asString();
        updateAvailability(manager, change).andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(current)).andExpect(jsonPath("$.open").value(false))
                .andExpect(jsonPath("$.slots[0].reserved").value(1));
        updateAvailability(manager, scheduleChange(version, shiftId, date, "11:30", "12:00", 4))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pickup_schedule_conflict"));
        updateAvailability(manager, scheduleChange(version, UUID.randomUUID(), date, "12:00", "12:10", 3))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("catalog_version_conflict"));
        assertThat(jdbc.sql("""
                SELECT operator_username || ':' || previous_version || ':' || new_version
                FROM pickup_schedule_publications WHERE store_id = ? AND id = ? AND operator_id = ? AND capacity = 3
                """).params(store, shiftId, staff.id()).query(String.class).single())
                .isEqualTo(staff.username() + ":" + version + ":" + revision);
        assertThat(jdbc.sql("SELECT slot_id FROM orders WHERE id = ?").param(UUID.fromString(orderId))
                .query(String.class).single()).isEqualTo(firstSlot);
    }

    @Test
    void pickupScheduleValidatesBoundsAndAllowsAdjacentAndNextDayWindows() throws Exception {
        String manager = login(newStaff(store, "manager"));
        LocalDate date = tomorrowInKigali();
        String version = availability(manager).path("version").asString();
        UUID shiftId = UUID.randomUUID();
        for (String invalid : List.of(
                scheduleChange(version, shiftId, date, "11:35", "11:50", 3),
                scheduleChange(version, shiftId, date, "11:30", "11:45", 3),
                scheduleChange(version, shiftId, date, "23:50", "24:00", 3),
                scheduleChange(version, shiftId, date, "23:50", "00:00", 3),
                scheduleChange(version, shiftId, date, "11:30", "11:30", 3),
                scheduleChange(version, shiftId, date, "11:30", "12:00", 0),
                scheduleChange(version, shiftId, date, "11:30", "12:00", -1),
                scheduleChange(version, shiftId, date, "11:30", "12:00", 2147483648L),
                scheduleChange(version, shiftId, date, "11:30", "12:00", 1.5),
                scheduleChange(version, shiftId, "2027-02-30", "11:30", "12:00", 3),
                scheduleChange(version, shiftId, date, "11:30", "12:00", 3).replace(shiftId.toString(), "bad-key"))) {
            updateAvailability(manager, invalid).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("invalid_input"));
        }
        updateAvailability(manager, scheduleChange(version, shiftId, date.minusDays(2), "11:30", "12:00", 3))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pickup_schedule_started"));
        String first = body(updateAvailability(manager, scheduleChange(version, shiftId, date, "11:30", "12:00", Integer.MAX_VALUE))
                .andExpect(status().isOk())).path("version").asString();
        updateAvailability(manager, scheduleChange(first, UUID.randomUUID(), date, "11:20", "11:40", 3))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pickup_schedule_overlap"));
        updateAvailability(manager, scheduleChange(first, UUID.randomUUID(), date, "11:40", "12:00", 3))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pickup_schedule_overlap"));
        String adjacent = body(updateAvailability(manager, scheduleChange(first, UUID.randomUUID(), date, "12:00", "12:10", 3))
                .andExpect(status().isOk())).path("version").asString();
        updateAvailability(manager, scheduleChange(adjacent, UUID.randomUUID(), date.plusDays(1), "11:30", "12:00", 3))
                .andExpect(status().isOk()).andExpect(jsonPath("$.slots.length()").value(8));
        assertThat(jdbc.sql("SELECT count(*) FROM pickup_schedule_publications WHERE store_id = ?")
                .param(store).query(Long.class).single()).isEqualTo(3);
        assertThat(jdbc.sql("SELECT capacity FROM pickup_slots WHERE store_id = ? AND id = ?")
                .params(store, "shift-" + shiftId + "-1").query(Integer.class).single()).isEqualTo(Integer.MAX_VALUE);
    }

    @Test
    void aCollidingSlotIdRollsBackTheEntireShiftAndLeavesTheOriginalSlot() throws Exception {
        String manager = login(newStaff(store, "manager"));
        UUID shiftId = UUID.randomUUID();
        String prefix = "shift-" + shiftId;
        jdbc.sql("""
                INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
                VALUES (?, ?, now() + interval '4 days', now() + interval '4 days 10 minutes', 7)
                """).params(store, prefix + "-2").update();
        String version = availability(manager).path("version").asString();
        String change = scheduleChange(version, shiftId, tomorrowInKigali(), "11:30", "11:50", 3);
        updateAvailability(manager, change).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("pickup_schedule_conflict"));
        assertThat(availability(manager).path("version").asString()).isEqualTo(version);
        assertThat(jdbc.sql("SELECT id || ':' || capacity FROM pickup_slots WHERE store_id = ? AND id LIKE ?")
                .params(store, prefix + "%").query(String.class).list()).containsExactly(prefix + "-2:7");
        assertThat(jdbc.sql("SELECT count(*) FROM pickup_schedule_publications WHERE store_id = ?")
                .param(store).query(Long.class).single()).isZero();
    }

    @Test
    void anExactRetryAfterTheShiftElapsedReturnsTheCurrentCatalog() throws Exception {
        Staff actor = newStaff(store, "manager");
        String manager = login(actor);
        UUID publishedId = UUID.randomUUID();
        LocalDate elapsed = tomorrowInKigali().minusDays(2);
        jdbc.sql("""
                INSERT INTO pickup_schedule_publications (store_id, id, schedule_date, start_time, end_time, capacity,
                    operator_id, operator_username, previous_version, new_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'before-shift', 'published-shift')
                """).params(store, publishedId, elapsed, LocalTime.of(11, 30), LocalTime.of(12, 0), 3,
                    actor.id(), actor.username()).update();
        String current = availability(manager).path("version").asString();
        updateAvailability(manager, scheduleChange("before-shift", publishedId, elapsed, "11:30", "12:00", 3))
                .andExpect(status().isOk()).andExpect(jsonPath("$.version").value(current))
                .andExpect(jsonPath("$.slots.length()").value(1));
        updateAvailability(manager, scheduleChange(current, UUID.randomUUID(), elapsed, "11:30", "12:00", 3))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pickup_schedule_started"));
    }

    private LocalDate tomorrowInKigali() {
        return jdbc.sql("SELECT (clock_timestamp() AT TIME ZONE 'Africa/Kigali')::date + 1")
                .query(LocalDate.class).single();
    }

    private String scheduleChange(String version, UUID id, Object date, String start, String end, Number capacity) {
        return json.writeValueAsString(Map.of("expectedVersion", version, "pickupSchedule", Map.of(
                "id", id.toString(), "date", date.toString(), "start", start, "end", end, "capacity", capacity)));
    }

    private JsonNode availability(String bearer) throws Exception {
        return body(api.perform(get(OPERATOR + "/availability").header(HttpHeaders.AUTHORIZATION, bearer))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
    }

    private ResultActions updateAvailability(String bearer, String payload) throws Exception {
        return api.perform(patch(OPERATOR + "/availability").header(HttpHeaders.AUTHORIZATION, bearer)
            .contentType(MediaType.APPLICATION_JSON).content(payload));
    }

    private long auditCount(String location) {
        return jdbc.sql("SELECT count(*) FROM operator_availability_events WHERE store_id = ?")
            .param(location).query(Long.class).single();
    }

    private String storeChange(String version, boolean open) {
        return json.writeValueAsString(Map.of("expectedVersion", version, "open", open));
    }

    private String productChange(String version, String sku, boolean available) {
        return json.writeValueAsString(Map.of("expectedVersion", version, "sku", sku, "available", available));
    }

    private String slotChange(String version, String slot, int capacity) {
        return json.writeValueAsString(Map.of("expectedVersion", version, "slotId", slot, "capacity", capacity));
    }

    private String newStore() {
        String id = "operator-it-" + UUID.randomUUID();
        stores.add(id);
        jdbc.sql("""
                INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
                SELECT ?, name, area, hours, open, tax_basis_points, version FROM stores WHERE id = 'kigali'
                """).param(id).update();
        jdbc.sql("""
                INSERT INTO menu_products (store_id, sku, position, product)
                SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
                """).param(id).update();
        jdbc.sql("""
                INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
                VALUES (?, ?, now() + interval '25 minutes', now() + interval '35 minutes', 4)
                """).params(id, SLOT).update();
        return id;
    }

    private Staff newStaff(String storeId, String role) {
        Staff staff = new Staff(UUID.randomUUID(), "tester-" + UUID.randomUUID(), storeId, role);
        jdbc.sql("INSERT INTO operator_accounts (id, username, store_id, role, password_hash) VALUES (?, ?, ?, ?, ?)")
                .params(staff.id(), staff.username(), staff.storeId(), staff.role(), PASSWORD_HASH).update();
        return staff;
    }

    private ResultActions postLogin(Staff staff, String password) throws Exception {
        return api.perform(post(OPERATOR + "/sessions").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("username", staff.username(), "password", password))));
    }

    private String login(Staff staff) throws Exception {
        JsonNode session = body(postLogin(staff, PASSWORD).andExpect(status().isCreated())
                .andExpect(jsonPath("$.storeId").value(staff.storeId()))
                .andExpect(jsonPath("$.role").value(staff.role()))
                .andExpect(jsonPath("$.expiresAt").isString()));
        return "Bearer " + session.path("accessToken").asString("");
    }

    private OrderFixture newOrder(String storeId, boolean paid) throws Exception {
        return newOrder(storeId, paid, null);
    }

    private OrderFixture newOrder(String storeId, boolean paid, UUID fixtureId) throws Exception {
        String bearer = newGuest();
        String quoteId = body(quote(bearer, storeId).andExpect(status().isOk())).path("quoteId").asString("");
        String orderId = body(createOrder(bearer, quoteId, "fixture-order")
                .andExpect(status().isOk())).path("id").asString("");
        if (fixtureId != null) {
            jdbc.sql("UPDATE orders SET id = ? WHERE id = ?").params(fixtureId, UUID.fromString(orderId)).update();
            orderId = fixtureId.toString();
        }
        if (!paid) {
            return new OrderFixture(orderId, bearer, null);
        }
        String attemptId = beginPayment(bearer, orderId);
        String code = body(api.perform(post(API + "/local/orders/" + orderId + "/payments/" + attemptId + "/result")
                .header(HttpHeaders.AUTHORIZATION, bearer).contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"paid\"}"))
                .andExpect(status().isOk())).path("pickupCode").asString("");
        assertThat(code).matches("[0-9]{6}");
        return new OrderFixture(orderId, bearer, code);
    }

    private String newGuest() throws Exception {
        String token = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk())).path("accessToken").asString("");
        guests.add(jdbc.sql("SELECT guest_session_id FROM guest_access_tokens WHERE token_hash = ?")
                .param(sha256(token)).query(UUID.class).single());
        return "Bearer " + token;
    }

    private ResultActions quote(String bearer, String storeId) throws Exception {
        return quote(bearer, storeId, SLOT);
    }

    private ResultActions quote(String bearer, String storeId, String slotId) throws Exception {
        return api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, bearer)
                .contentType(MediaType.APPLICATION_JSON).content("""
                    {"storeId":"%s","slotId":"%s","lines":[{"sku":"double-smash","modifierIds":["extra-cheese"],"quantity":1,"unitPrice":9700}]}
                    """.formatted(storeId, slotId)));
    }

    private ResultActions createOrder(String bearer, String quoteId, String key) throws Exception {
        return api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, bearer)
                .header(IDEMPOTENCY, key).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("quoteId", quoteId, "phone", "+250700000000", "email", "guest@example.test"))));
    }

    private String beginPayment(String bearer, String orderId) throws Exception {
        return body(api.perform(post(API + "/orders/" + orderId + "/payments")
                .header(HttpHeaders.AUTHORIZATION, bearer).header(IDEMPOTENCY, "fixture-payment"))
                .andExpect(status().isOk())).path("id").asString("");
    }

    private ResultActions change(String bearer, String orderId, String next, String code) throws Exception {
        var input = Map.of("status", next);
        if (code != null) {
            input = Map.of("status", next, "pickupCode", code);
        }
        return api.perform(post(OPERATOR + "/orders/" + orderId + "/status").header(HttpHeaders.AUTHORIZATION, bearer)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(input)));
    }

    private ResultActions cancel(String bearer, String orderId) throws Exception {
        return api.perform(post(OPERATOR + "/orders/" + orderId + "/cancel").header(HttpHeaders.AUTHORIZATION, bearer));
    }

    private ResultActions pickupStatus(String bearer, String orderId) throws Exception {
        return api.perform(get(OPERATOR + "/orders/{id}/pickup-status", orderId).header(HttpHeaders.AUTHORIZATION, bearer));
    }

    private ResultActions counterLookup(String bearer, String code) throws Exception {
        return api.perform(get(OPERATOR + "/orders/lookup").queryParam("orderCode", code)
                .header(HttpHeaders.AUTHORIZATION, bearer));
    }

    private void assertPickupStatus(String bearer, String orderId, String expectedStatus, boolean confirmed) throws Exception {
        JsonNode result = body(pickupStatus(bearer, orderId).andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.id").value(orderId))
                .andExpect(jsonPath("$.status").value(expectedStatus))
                .andExpect(jsonPath("$.confirmedByCurrentOperator").value(confirmed)));
        assertThat(keys(result)).containsExactlyInAnyOrder("id", "status", "confirmedByCurrentOperator");
    }

    private int collectAfterBarrier(CountDownLatch waiting, CountDownLatch start, String bearer, OrderFixture order) throws Exception {
        waiting.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) {
            throw new IllegalStateException("Collection start barrier timed out");
        }
        return change(bearer, order.orderId(), "collected", order.code()).andReturn().getResponse().getStatus();
    }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }

    private static String sha256(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII)));
    }

    private static List<String> keys(JsonNode object) {
        List<String> keys = new ArrayList<>();
        keys.addAll(object.propertyNames());
        return keys;
    }

    private record Staff(UUID id, String username, String storeId, String role) { }

    private record OrderFixture(String orderId, String guestBearer, String code) { }
}
