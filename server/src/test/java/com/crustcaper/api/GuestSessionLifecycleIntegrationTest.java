package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {"crustcaper.order-access.provider=disabled", "crustcaper.push.provider=disabled"})
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GuestSessionLifecycleIntegrationTest {
    private static final String SESSIONS = "/api/v1/guest-sessions";
    private static final String ORDERS = "/api/v1/orders";
    private static final String SLOT = "session-test-slot";

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired GuestSessions sessions;

    private final List<UUID> guests = new ArrayList<>();
    private String store;

    @AfterEach
    void removeFixtures() {
        if (store != null) {
            for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
                jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
            }
            jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        }
        guests.forEach(id -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(id).update());
    }

    @Test
    void legacyAndRotatingRefreshKeepTheOwnerAcrossALostReply() throws Exception {
        JsonNode guest = createGuest();
        String original = token(guest);
        String key = UUID.randomUUID().toString();
        String order = createOrder(guest);

        JsonNode legacy = body(refresh(original, null).andExpect(status().isOk()));
        assertThat(token(legacy)).isEqualTo(original);
        assertThat(legacy.path("sessionId")).isEqualTo(guest.path("sessionId"));

        JsonNode first = body(refresh(original, key).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        String successor = token(first);
        assertThat(successor).matches("[A-Za-z0-9_-]{43}").isNotEqualTo(original);
        assertThat(first.path("sessionId")).isEqualTo(guest.path("sessionId"));
        assertThat(first.path("sessionId").asString("")).isEqualTo(guests.getFirst().toString());
        assertThat(first.path("refreshExpiresAt")).isEqualTo(guest.path("refreshExpiresAt"));
        String storedHash = jdbc.sql("SELECT refresh_token_hash FROM guest_sessions WHERE id = ?")
            .param(guests.getFirst()).query(String.class).single();
        assertThat(storedHash).isEqualTo(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(successor.getBytes(StandardCharsets.US_ASCII))));

        refresh(original, null).andExpect(status().isUnauthorized());
        refresh(original, UUID.randomUUID().toString()).andExpect(status().isUnauthorized());
        JsonNode retry = body(refresh(original, key).andExpect(status().isOk()));
        assertThat(token(retry)).isEqualTo(successor);
        assertThat(retry.path("sessionId")).isEqualTo(guest.path("sessionId"));
        assertThat(retry.path("refreshExpiresAt")).isEqualTo(guest.path("refreshExpiresAt"));
        readOrder(order, retry).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(order));

        refresh(successor, UUID.randomUUID().toString()).andExpect(status().isOk());
        refresh(original, key).andExpect(status().isUnauthorized());
    }

    @Test
    void simultaneousDifferentRotationKeysHaveOnlyOneWinner() throws Exception {
        String original = token(createGuest());
        String firstKey = UUID.randomUUID().toString();
        String secondKey = UUID.randomUUID().toString();
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);

        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> refreshAtBarrier(original, firstKey, ready, start));
            var second = executor.submit(() -> refreshAtBarrier(original, secondKey, ready, start));
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            MockHttpServletResponse firstResponse = first.get(8, TimeUnit.SECONDS);
            MockHttpServletResponse secondResponse = second.get(8, TimeUnit.SECONDS);
            assertThat(List.of(firstResponse.getStatus(), secondResponse.getStatus())).containsExactlyInAnyOrder(200, 401);
            boolean firstWon = firstResponse.getStatus() == 200;
            String winner = firstWon ? firstKey : secondKey;
            String loser = firstWon ? secondKey : firstKey;
            String successor = token(json.readTree((firstWon ? firstResponse : secondResponse).getContentAsByteArray()));
            refresh(original, winner).andExpect(status().isOk()).andExpect(jsonPath("$.refreshToken").value(successor));
            refresh(original, loser).andExpect(status().isUnauthorized());
        }
    }

    @Test
    void revokeAfterLostRotationExpiresBothAccessTokensAndPreservesTheOrder() throws Exception {
        JsonNode guest = createGuest();
        String order = createOrder(guest);
        String original = token(guest);
        String rotationKey = UUID.randomUUID().toString();
        JsonNode refreshed = body(refresh(original, rotationKey).andExpect(status().isOk()));

        revoke(original, UUID.randomUUID().toString()).andExpect(status().isNoContent());
        readOrder(order, refreshed).andExpect(status().isOk());
        revoke(original, rotationKey).andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")).andExpect(content().string(""));
        revoke(original, rotationKey).andExpect(status().isNoContent());
        revoke(token(refreshed), null).andExpect(status().isNoContent());

        readOrder(order, guest).andExpect(status().isUnauthorized());
        readOrder(order, refreshed).andExpect(status().isUnauthorized());
        refresh(original, rotationKey).andExpect(status().isUnauthorized());
        refresh(token(refreshed), null).andExpect(status().isUnauthorized());
        UUID owner = guests.getFirst();
        assertThat(jdbc.sql("SELECT count(*) FROM guest_access_tokens WHERE guest_session_id = ?")
            .param(owner).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("""
            SELECT expires_at <= clock_timestamp() AND token_hash IS NULL AND refresh_token_hash IS NULL
            FROM guest_sessions WHERE id = ?
            """).param(owner).query(Boolean.class).single()).isTrue();
        assertThat(jdbc.sql("SELECT guest_session_id FROM orders WHERE id = ?")
            .param(UUID.fromString(order)).query(UUID.class).single()).isEqualTo(owner);
    }

    @Test
    void rejectsMalformedRotationKeysAndDoesNotRevealUnknownOrExpiredSessionsOnRevoke() throws Exception {
        JsonNode guest = createGuest();
        String token = token(guest);
        refresh(token, "bad-key").andExpect(status().isBadRequest());
        revoke(token, "bad-key").andExpect(status().isBadRequest());
        refresh(token, null).andExpect(status().isOk());

        jdbc.sql("UPDATE guest_sessions SET expires_at = clock_timestamp() WHERE id = ?")
            .param(guests.getFirst()).update();
        revoke(token, null).andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
        revoke("E".repeat(43), null).andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
    }

    @Test
    void revokedGuestCannotPlaceAnOrderFromAnExistingQuote() throws Exception {
        JsonNode guest = createGuest();
        var input = prepareOrder(guest);
        revoke(token(guest), null).andExpect(status().isNoContent());

        placeOrder(guest, input).andExpect(status().isUnauthorized());
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?")
            .param(store).query(Long.class).single()).isZero();
        api.perform(get("/api/v1/stores/" + store + "/menu"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.slots[0].available").value(true));
    }

    private JsonNode createGuest() throws Exception {
        JsonNode created = body(api.perform(post(SESSIONS)).andExpect(status().isOk()));
        guests.add(sessions.authenticate(bearer(created)));
        return created;
    }

    private String createOrder(JsonNode guest) throws Exception {
        return body(placeOrder(guest, prepareOrder(guest)).andExpect(status().isOk())).path("id").asString("");
    }

    private ApiModels.OrderInput prepareOrder(JsonNode guest) throws Exception {
        store = "session-test-" + UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, open, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '25 minutes', now() + interval '35 minutes', 1)
            """).params(store, SLOT).update();

        var input = new ApiModels.QuoteInput(store, SLOT, List.of(new ApiModels.CartLine("double-smash", List.of(), 1, 9200)));
        JsonNode quote = body(api.perform(post("/api/v1/quotes").header(HttpHeaders.AUTHORIZATION, bearer(guest))
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(input))).andExpect(status().isOk()));
        return new ApiModels.OrderInput(quote.path("quoteId").asString(""), "+250700000000", "session@example.test");
    }

    private ResultActions placeOrder(JsonNode guest, ApiModels.OrderInput orderInput) throws Exception {
        return api.perform(post(ORDERS).header(HttpHeaders.AUTHORIZATION, bearer(guest))
            .header("Idempotency-Key", "guest-session-order").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(orderInput)));
    }

    private MockHttpServletResponse refreshAtBarrier(String token, String key, CountDownLatch ready, CountDownLatch start)
            throws Exception {
        ready.countDown();
        assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
        return refresh(token, key).andReturn().getResponse();
    }

    private ResultActions refresh(String token, String key) throws Exception {
        return sessionRequest("/refresh", token, key);
    }

    private ResultActions revoke(String token, String key) throws Exception {
        return sessionRequest("/revoke", token, key);
    }

    private ResultActions sessionRequest(String suffix, String token, String key) throws Exception {
        var body = key == null ? Map.of("refreshToken", token) : Map.of("refreshToken", token, "rotationKey", key);
        return api.perform(post(SESSIONS + suffix).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(body)));
    }

    private ResultActions readOrder(String id, JsonNode guest) throws Exception {
        return api.perform(get(ORDERS + "/{id}", id).header(HttpHeaders.AUTHORIZATION, bearer(guest)));
    }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }

    private static String bearer(JsonNode session) {
        return "Bearer " + session.path("accessToken").asString("");
    }

    private static String token(JsonNode session) {
        return session.path("refreshToken").asString("");
    }
}
