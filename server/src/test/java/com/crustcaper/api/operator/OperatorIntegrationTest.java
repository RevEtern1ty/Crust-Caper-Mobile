package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
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

        assertThat(queue.path("orders").size()).isEqualTo(1);
        JsonNode visible = queue.path("orders").get(0);
        assertThat(visible.path("id").asString("")).isEqualTo(accepted.orderId());
        assertThat(visible.path("status").asString("")).isEqualTo("accepted");
        assertThat(visible.path("paymentStatus").asString("")).isEqualTo("paid");
        assertThat(keys(visible)).containsExactlyInAnyOrder("id", "status", "paymentStatus", "lines", "pickupStartsAt", "pickupEndsAt");
        assertThat(keys(visible.path("lines").get(0))).containsExactlyInAnyOrder("sku", "modifierIds", "quantity");
        change(staffBearer, differentStore.orderId(), "preparing", null).andExpect(status().isNotFound());
        change(staffBearer, unpaid.orderId(), "preparing", null).andExpect(status().isNotFound());
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
        String token = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk())).path("accessToken").asString("");
        guests.add(jdbc.sql("SELECT guest_session_id FROM guest_access_tokens WHERE token_hash = ?")
                .param(sha256(token)).query(UUID.class).single());
        String bearer = "Bearer " + token;
        String quoteId = body(api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, bearer)
                .contentType(MediaType.APPLICATION_JSON).content("""
                    {"storeId":"%s","slotId":"%s","lines":[{"sku":"double-smash","modifierIds":["extra-cheese"],"quantity":1,"unitPrice":9700}]}
                    """.formatted(storeId, SLOT))).andExpect(status().isOk())).path("quoteId").asString("");
        String orderId = body(api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, bearer)
                .header(IDEMPOTENCY, "fixture-order").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("quoteId", quoteId, "phone", "+250700000000", "email", "guest@example.test"))))
                .andExpect(status().isOk())).path("id").asString("");
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
