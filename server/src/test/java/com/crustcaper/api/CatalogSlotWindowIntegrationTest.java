package com.crustcaper.api;

import static org.hamcrest.Matchers.contains;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
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
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class CatalogSlotWindowIntegrationTest {
    private static final String ROOT = "/api/v1";

    @Autowired MockMvc api;
    @Autowired ObjectMapper json;
    @Autowired JdbcClient jdbc;
    @Autowired GuestSessions sessions;

    private final String store = "slot-window-" + UUID.randomUUID();
    private final UUID existingGuest = UUID.randomUUID();
    private UUID buyer;

    @BeforeEach
    void seedStore() {
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, 'slot-window' FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, jsonb_set(product, '{price}', '9200')
            FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            SELECT ?, 'slot-' || lpad(n::text, 2, '0'),
                now() + make_interval(mins => CASE WHEN n BETWEEN 12 AND 14 THEN 120 ELSE n * 10 END),
                now() + make_interval(mins => CASE WHEN n BETWEEN 12 AND 14 THEN 130 ELSE n * 10 + 10 END),
                CASE WHEN n < 12 THEN 0 ELSE 1 END
            FROM generate_series(1, 15) AS slots(n)
            """).param(store).update();
        jdbc.sql("INSERT INTO guest_sessions (id, expires_at) VALUES (?, now() + interval '1 hour')")
            .param(existingGuest).update();
        jdbc.sql("""
            INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at, lines, total, tax, expires_at)
            SELECT gen_random_uuid(), ?, store_id, id, starts_at, ends_at, '[]'::jsonb, 9200, 0, now() - interval '15 minutes'
            FROM pickup_slots WHERE store_id = ? AND id IN ('slot-12', 'slot-13', 'slot-14')
            """).params(existingGuest, store).update();
        jdbc.sql("""
            INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone, lines, total, tax,
                status, payment_status, created_at, reservation_expires_at, pickup_starts_at, pickup_ends_at)
            SELECT gen_random_uuid(), id, guest_session_id, slot_id, store_id, slot_id, '+250700000000', lines, total, tax,
                CASE slot_id WHEN 'slot-13' THEN 'accepted' ELSE 'awaiting_payment' END,
                CASE slot_id WHEN 'slot-13' THEN 'paid' ELSE 'unpaid' END,
                now() - interval '20 minutes',
                now() + CASE slot_id WHEN 'slot-12' THEN interval '10 minutes' ELSE interval '-5 minutes' END,
                pickup_starts_at, pickup_ends_at FROM quotes WHERE store_id = ?
            """).param(store).update();
    }

    @AfterEach
    void removeStore() {
        jdbc.sql("DELETE FROM orders WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM quotes WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM pickup_slots WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM menu_products WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        jdbc.sql("DELETE FROM guest_sessions WHERE id IN (?, ?)").params(existingGuest, buyer).update();
    }

    @Test
    void theFirstBookableSlotBeyondTheFullWindowCanBeQuotedAndReserved() throws Exception {
        menu().andExpect(jsonPath("$.slots[*].id", contains("slot-01", "slot-02", "slot-03", "slot-04",
            "slot-05", "slot-06", "slot-07", "slot-08", "slot-09", "slot-10", "slot-11", "slot-14")))
            .andExpect(jsonPath("$.slots[?(@.available == true)].id", contains("slot-14")));

        String bearer = openGuest();
        quote(bearer, "slot-13").andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("slot_unavailable"));
        var quote = quote(bearer, "slot-14").andExpect(status().isOk()).andReturn().getResponse();
        String quoteId = json.readTree(quote.getContentAsByteArray()).path("quoteId").asString();
        api.perform(post(ROOT + "/orders").header(HttpHeaders.AUTHORIZATION, bearer).header("Idempotency-Key", "slot-window-order")
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"quoteId":"%s","phone":"+250700000000"}
                """.formatted(quoteId)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.slotId").value("slot-14"))
            .andExpect(jsonPath("$.status").value("awaiting_payment"));
        quote(bearer, "slot-14").andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("slot_unavailable"));
        menu().andExpect(jsonPath("$.slots.length()").value(12))
            .andExpect(jsonPath("$.slots[?(@.available == true)].id", contains("slot-15")));
    }

    @Test
    void aPausedStoreAndAnExhaustedScheduleDoNotAdvertiseBookableSlots() throws Exception {
        jdbc.sql("UPDATE stores SET open = false WHERE id = ?").param(store).update();
        menu().andExpect(jsonPath("$.store.open").value(false)).andExpect(jsonPath("$.slots.length()").value(12))
            .andExpect(jsonPath("$.slots[11].id").value("slot-12"))
            .andExpect(jsonPath("$.slots[?(@.available == true)]").isEmpty());
        quote(openGuest(), "slot-14").andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("slot_unavailable"));

        jdbc.sql("UPDATE stores SET open = true WHERE id = ?").param(store).update();
        jdbc.sql("UPDATE pickup_slots SET capacity = 0 WHERE store_id = ? AND id IN ('slot-14', 'slot-15')")
            .param(store).update();
        menu().andExpect(jsonPath("$.store.open").value(true)).andExpect(jsonPath("$.slots.length()").value(12))
            .andExpect(jsonPath("$.slots[11].id").value("slot-12"))
            .andExpect(jsonPath("$.slots[?(@.available == true)]").isEmpty());
    }

    private ResultActions menu() throws Exception {
        return api.perform(get(ROOT + "/stores/{id}/menu", store).param("channel", "web").param("locale", "rw"))
            .andExpect(status().isOk());
    }

    private String openGuest() throws Exception {
        var response = api.perform(post(ROOT + "/guest-sessions")).andExpect(status().isOk()).andReturn().getResponse();
        String bearer = "Bearer " + json.readTree(response.getContentAsByteArray()).path("accessToken").asString();
        buyer = sessions.authenticate(bearer);
        return bearer;
    }

    private ResultActions quote(String bearer, String slot) throws Exception {
        return api.perform(post(ROOT + "/quotes").header(HttpHeaders.AUTHORIZATION, bearer)
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"storeId":"%s","slotId":"%s","lines":[{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]}
                """.formatted(store, slot)));
    }
}
