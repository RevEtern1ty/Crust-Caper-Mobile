package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.crustcaper.api.push.PickupPushCipher;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = "crustcaper.push.provider=disabled")
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Import(PickupAlertIntegrationTest.CipherFixture.class)
class PickupAlertIntegrationTest {
    private static final String ORDERS = "/api/v1/orders";
    private static final String OPERATOR = "/api/v1/operator";
    private static final String TOKEN = "ExponentPushToken[pickup-alert-synthetic]";
    private static final String TOKEN_REPLACEMENT = "ExpoPushToken[rotated-synthetic]";
    private static final String KEY = "Idempotency-Key";
    private static final String HEADER = "X-Installation-Id";
    private static final String PASSWORD = "synthetic-pickup-alert-fixture";
    private static final String HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired PickupPushCipher cipher;

    private final String store = "pickup-alert-test-" + UUID.randomUUID();
    private final List<UUID> guests = new ArrayList<>();

    record Guest(UUID id, String bearer) {}
    record Order(UUID id, Guest owner) {}

    @TestConfiguration(proxyBeanMethods = false)
    static class CipherFixture {
        @Bean
        PickupPushCipher syntheticPickupCipher() {
            return new PickupPushCipher(Base64.getEncoder().encodeToString(new byte[32]));
        }
    }

    @BeforeEach
    void fixture() {
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'pickup-alert', now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).param(store).update();
    }

    @AfterEach
    void removeOnlyFixtures() {
        jdbc.sql("DELETE FROM operator_order_events WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operator_accounts WHERE store_id = ?)")
            .param(store).update();
        jdbc.sql("DELETE FROM operator_accounts WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
            .param(store).update();
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void ownerAndVerifiedGuestAreScopedByOrderAndInstallationAndTokenIsEncrypted() throws Exception {
        Order order = order(true);
        Guest confirmed = guest();
        Guest stranger = guest();
        grant(confirmed, order);
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        api.perform(get(path(order)).header(HEADER, first)).andExpect(status().isUnauthorized());
        for (String header : List.of("not-a-uuid", "AB000000-0000-4000-8000-000000000001")) {
            api.perform(get(path(order)).header(HttpHeaders.AUTHORIZATION, order.owner().bearer()).header(HEADER, header))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_input"));
        }
        getAlert(stranger, order, first).andExpect(status().isNotFound());
        enroll(stranger, order, first, TOKEN, "en").andExpect(status().isNotFound());
        revoke(stranger, order, first).andExpect(status().isNotFound());
        enroll(order.owner(), order, first, "unsupported-token", "en").andExpect(status().isBadRequest());
        enroll(order.owner(), order, first, TOKEN, "fr").andExpect(status().isBadRequest());

        enroll(order.owner(), order, first, TOKEN, "rw").andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(content().json("{\"enabled\":true,\"available\":true}"));
        byte[] stored = storedCiphertext(order, order.owner(), first);
        assertThat(new String(stored, StandardCharsets.ISO_8859_1)).doesNotContain(TOKEN);
        assertThat(cipher.decrypt(order.id(), order.owner().id(), first, stored)).isEqualTo(TOKEN);
        assertThatThrownBy(() -> cipher.decrypt(order.id(), order.owner().id(), second, stored))
            .hasMessage("Pickup push token decryption failed");
        getAlert(order.owner(), order, second)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(content().json("{\"enabled\":false,\"available\":true}"));
        enroll(order.owner(), order, second, TOKEN, "en").andExpect(status().isOk());
        enroll(order.owner(), order, second, TOKEN_REPLACEMENT, "rw").andExpect(status().isOk());
        assertThat(cipher.decrypt(order.id(), order.owner().id(), second, storedCiphertext(order, order.owner(), second)))
            .isEqualTo(TOKEN_REPLACEMENT);
        enroll(confirmed, order, first, TOKEN, "en").andExpect(status().isOk());

        revoke(order.owner(), order, first).andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
        revoke(order.owner(), order, first).andExpect(status().isNoContent());
        getAlert(order.owner(), order, first).andExpect(content().json("{\"enabled\":false}"));
        getAlert(order.owner(), order, second).andExpect(content().json("{\"enabled\":true}"));
        getAlert(confirmed, order, first).andExpect(content().json("{\"enabled\":true}"));
        assertThat(dbState(order, order.owner(), first)).isEqualTo("cancelled");
        assertThat(storedCiphertext(order, order.owner(), first)).isNull();
        assertThat(count(order)).isEqualTo(3);
    }

    @Test
    void capsNewIdsEvenAfterRevocationAndDoesNotAllowEnrollmentAfterReady() throws Exception {
        Order unpaid = order(false);
        enroll(unpaid.owner(), unpaid, UUID.randomUUID(), TOKEN, "en").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("pickup_alert_unavailable"));

        Order paid = order(true);
        UUID first = UUID.randomUUID();
        enroll(paid.owner(), paid, first, TOKEN, "en").andExpect(status().isOk());
        for (int i = 0; i < 3; i++) {
            enroll(paid.owner(), paid, UUID.randomUUID(), TOKEN, "en").andExpect(status().isOk());
        }
        revoke(paid.owner(), paid, first).andExpect(status().isNoContent());
        enroll(paid.owner(), paid, UUID.randomUUID(), TOKEN, "en").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("pickup_alert_limit"));
        enroll(paid.owner(), paid, first, TOKEN_REPLACEMENT, "rw").andExpect(status().isOk());

        for (int actor = 0; actor < 2; actor++) {
            Guest reader = guest();
            grant(reader, paid);
            for (int i = 0; i < 4; i++) {
                enroll(reader, paid, UUID.randomUUID(), TOKEN, "en").andExpect(status().isOk());
            }
        }
        Guest reader = guest();
        grant(reader, paid);
        enroll(reader, paid, UUID.randomUUID(), TOKEN, "en").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("pickup_alert_limit"));
        assertThat(count(paid)).isEqualTo(12);
        String kitchen = kitchen();
        kitchenStatus(kitchen, paid, "preparing").andExpect(status().isOk());
        kitchenStatus(kitchen, paid, "ready").andExpect(status().isOk());
        assertThat(dbState(paid, paid.owner(), first)).isEqualTo("pending");
        enroll(paid.owner(), paid, first, TOKEN, "en").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("pickup_alert_unavailable"));
        revoke(paid.owner(), paid, first).andExpect(status().isNoContent());
        assertThat(dbState(paid, paid.owner(), first)).isEqualTo("cancelled");
        assertThat(storedCiphertext(paid, paid.owner(), first)).isNull();
    }

    @Test
    void anExpiredPickupWindowPreventsNewEnrollmentButStillAllowsRevocation() throws Exception {
        Order paid = order(true);
        UUID enrolled = UUID.randomUUID();
        enroll(paid.owner(), paid, enrolled, TOKEN, "en").andExpect(status().isOk());
        kitchenStatus(kitchen(), paid, "preparing").andExpect(status().isOk());
        jdbc.sql("""
            UPDATE orders SET pickup_starts_at = clock_timestamp() - interval '15 minutes',
                pickup_ends_at = clock_timestamp() - interval '5 minutes' WHERE id = ?
            """).param(paid.id()).update();

        enroll(paid.owner(), paid, UUID.randomUUID(), TOKEN, "en").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("pickup_alert_unavailable"));
        enroll(paid.owner(), paid, enrolled, TOKEN_REPLACEMENT, "rw").andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("pickup_alert_unavailable"));
        getAlert(paid.owner(), paid, enrolled)
            .andExpect(content().json("{\"enabled\":true,\"available\":true}"));
        revoke(paid.owner(), paid, enrolled).andExpect(status().isNoContent());
        assertThat(storedCiphertext(paid, paid.owner(), enrolled)).isNull();
        assertThat(count(paid)).isOne();
    }

    @Test
    void concurrentReadyAndEnrollmentCannotLeaveAnEnabledWaitingAlert() throws Exception {
        Order paid = order(true);
        String kitchen = kitchen();
        kitchenStatus(kitchen, paid, "preparing").andExpect(status().isOk());
        UUID install = UUID.randomUUID();
        var start = new CountDownLatch(1);
        int registration;
        try (var pool = Executors.newFixedThreadPool(2)) {
            var ready = pool.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                return kitchenStatus(kitchen, paid, "ready").andReturn().getResponse().getStatus();
            });
            var enroll = pool.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                return enroll(paid.owner(), paid, install, TOKEN, "en").andReturn().getResponse().getStatus();
            });
            start.countDown();
            assertThat(ready.get(5, TimeUnit.SECONDS)).isEqualTo(200);
            registration = enroll.get(5, TimeUnit.SECONDS);
        }
        assertThat(registration).isIn(200, 409);
        if (registration == 200) {
            assertThat(dbState(paid, paid.owner(), install)).isEqualTo("pending");
        } else {
            assertThat(count(paid)).isZero();
        }
    }

    private ResultActions getAlert(Guest guest, Order order, UUID installation) throws Exception {
        return api.perform(get(path(order)).header(HttpHeaders.AUTHORIZATION, guest.bearer()).header(HEADER, installation));
    }

    private ResultActions enroll(Guest guest, Order order, UUID installation, String token, String locale) throws Exception {
        return api.perform(put(path(order)).header(HttpHeaders.AUTHORIZATION, guest.bearer()).header(HEADER, installation)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("token", token, "locale", locale))));
    }

    private ResultActions revoke(Guest guest, Order order, UUID installation) throws Exception {
        return api.perform(delete(path(order)).header(HttpHeaders.AUTHORIZATION, guest.bearer()).header(HEADER, installation));
    }

    private byte[] storedCiphertext(Order order, Guest guest, UUID installation) {
        return jdbc.sql("SELECT encrypted_token FROM pickup_alerts WHERE order_id = ? AND guest_session_id = ? AND installation_id = ?")
            .params(order.id(), guest.id(), installation)
            .query((rs, row) -> Optional.ofNullable(rs.getBytes(1))).single().orElse(null);
    }

    private String dbState(Order order, Guest guest, UUID installation) {
        return jdbc.sql("SELECT state FROM pickup_alerts WHERE order_id = ? AND guest_session_id = ? AND installation_id = ?")
            .params(order.id(), guest.id(), installation).query(String.class).single();
    }

    private long count(Order order) {
        return jdbc.sql("SELECT count(*) FROM pickup_alerts WHERE order_id = ?").param(order.id()).query(Long.class).single();
    }

    private void grant(Guest guest, Order order) {
        jdbc.sql("INSERT INTO order_read_grants (guest_session_id, order_id) VALUES (?, ?)")
            .params(guest.id(), order.id()).update();
    }

    private Guest guest() throws Exception {
        String token = body(api.perform(post("/api/v1/guest-sessions")).andExpect(status().isOk()))
            .path("accessToken").asString();
        UUID id = jdbc.sql("""
            SELECT guest_session_id FROM guest_access_tokens WHERE token_hash = encode(sha256(convert_to(?, 'UTF8')), 'hex')
            """).param(token).query(UUID.class).single();
        guests.add(id);
        return new Guest(id, "Bearer " + token);
    }

    private Order order(boolean paid) throws Exception {
        Guest guest = guest();
        String quote = body(api.perform(post("/api/v1/quotes").header(HttpHeaders.AUTHORIZATION, guest.bearer())
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"storeId":"%s","slotId":"pickup-alert","lines":[{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]}
                """.formatted(store))).andExpect(status().isOk())).path("quoteId").asString();
        String orderId = body(api.perform(post(ORDERS).header(HttpHeaders.AUTHORIZATION, guest.bearer()).header(KEY, "order")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("quoteId", quote, "phone", "+250700000000"))))
            .andExpect(status().isOk())).path("id").asString();
        if (paid) {
            String attempt = body(api.perform(post(ORDERS + "/" + orderId + "/payments")
                .header(HttpHeaders.AUTHORIZATION, guest.bearer()).header(KEY, "payment"))
                .andExpect(status().isOk())).path("id").asString();
            api.perform(post("/api/v1/local/orders/" + orderId + "/payments/" + attempt + "/result")
                .header(HttpHeaders.AUTHORIZATION, guest.bearer()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"paid\"}")).andExpect(status().isOk());
        }
        return new Order(UUID.fromString(orderId), guest);
    }

    private String kitchen() throws Exception {
        String username = "pickup-qa-" + UUID.randomUUID();
        jdbc.sql("INSERT INTO operator_accounts (id, store_id, username, role, password_hash) VALUES (?, ?, ?, 'kitchen', ?)")
            .params(UUID.randomUUID(), store, username, HASH).update();
        String token = body(api.perform(post(OPERATOR + "/sessions").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("username", username, "password", PASSWORD))))
            .andExpect(status().isCreated())).path("accessToken").asString();
        return "Bearer " + token;
    }

    private ResultActions kitchenStatus(String bearer, Order order, String status) throws Exception {
        return api.perform(post(OPERATOR + "/orders/" + order.id() + "/status").header(HttpHeaders.AUTHORIZATION, bearer)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("status", status))));
    }

    private static String path(Order order) { return ORDERS + "/" + order.id() + "/pickup-alert"; }

    private JsonNode body(ResultActions request) throws Exception {
        return json.readTree(request.andReturn().getResponse().getContentAsByteArray());
    }
}
