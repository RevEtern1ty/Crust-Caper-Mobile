package com.crustcaper.api;

import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;
import static org.hamcrest.Matchers.contains;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class CatalogSnapshotIntegrationTest {
    @Autowired MockMvc api;
    @Autowired PlatformTransactionManager transactionManager;
    @MockitoSpyBean Catalog catalog;
    @MockitoSpyBean JdbcClient jdbc;

    private final String store = "snapshot-test-" + UUID.randomUUID();
    private final UUID guest = UUID.randomUUID();

    @BeforeEach
    void insertSnapshotFixture() {
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, 'initial' FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, jsonb_set(product, '{price}', '9200')
            FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'snapshot-slot', now() + interval '25 minutes', now() + interval '35 minutes', 1)
            """).param(store).update();
    }

    @AfterEach
    void removeSnapshotFixture() {
        jdbc.sql("DELETE FROM orders WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM quotes WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM pickup_slots WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM menu_products WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update();
    }

    @Test
    void menuKeepsOneCatalogWhenAnImportCommitsBetweenReads() throws Exception {
        TransactionTemplate importer = new TransactionTemplate(transactionManager);
        importer.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        Catalog target = AopTestUtils.getUltimateTargetObject(catalog);
        doAnswer(invocation -> {
            var savedStore = invocation.callRealMethod();
            // Force a real separate commit after the menu reads the store but before its other reads.
            importer.executeWithoutResult(tx -> {
                jdbc.sql("UPDATE stores SET version = 'imported', open = false WHERE id = ?").param(store).update();
                jdbc.sql("UPDATE menu_products SET product = jsonb_set(product, '{price}', '9700') WHERE store_id = ?")
                    .param(store).update();
                jdbc.sql("UPDATE pickup_slots SET capacity = 0 WHERE store_id = ?").param(store).update();
            });
            return savedStore;
        }).doCallRealMethod().when(target).store(store, false);

        api.perform(get("/api/v1/stores/{id}/menu", store))
            .andExpect(status().isOk()).andExpect(jsonPath("$.version").value("initial"))
            .andExpect(jsonPath("$.store.open").value(true)).andExpect(jsonPath("$.products[0].price").value(9200))
            .andExpect(jsonPath("$.slots[0].available").value(true));
        api.perform(get("/api/v1/stores/{id}/menu", store))
            .andExpect(status().isOk()).andExpect(jsonPath("$.version").value("imported"))
            .andExpect(jsonPath("$.store.open").value(false)).andExpect(jsonPath("$.products[0].price").value(9700))
            .andExpect(jsonPath("$.slots[0].available").value(false));
    }

    @Test
    void menuReadsTheFirstTwelveFutureSlotsAndTheirCapacityInOneStatement() throws Exception {
        insertAvailabilityFixture();
        clearInvocations(jdbc);

        api.perform(get("/api/v1/stores/{id}/menu", store))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.slots[*].id", contains("snapshot-slot", "tie-a", "tie-b", "cancelled",
                "expired", "held", "paid", "zero-capacity", "extra-1", "extra-2", "extra-3", "extra-4")))
            .andExpect(jsonPath("$.slots[*].available", contains(true, true, true, true, true, false, false,
                false, true, true, true, true)));

        verify(jdbc).sql(argThat(query -> query.contains("FROM pickup_slots")
            || query.contains("pickup_reservation_occupies_slot")));

        jdbc.sql("UPDATE stores SET open = false WHERE id = ?").param(store).update();
        api.perform(get("/api/v1/stores/{id}/menu", store))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.slots[?(@.available == true)]").isEmpty());
    }

    private void insertAvailabilityFixture() {
        jdbc.sql("""
            WITH fixture(id, offset_minutes, capacity) AS (
                VALUES ('started', -5, 1), ('tie-b', 30, 1), ('tie-a', 30, 1), ('cancelled', 35, 1),
                    ('expired', 40, 1), ('held', 45, 1), ('paid', 50, 1), ('zero-capacity', 55, 0)
                UNION ALL
                SELECT 'extra-' || n, 60 + n, 1 FROM generate_series(1, 7) AS extra(n)
            )
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            SELECT ?, id, now() + make_interval(mins => offset_minutes),
                now() + make_interval(mins => offset_minutes + 10), capacity FROM fixture
            """).param(store).update();
        jdbc.sql("INSERT INTO guest_sessions (id, expires_at) VALUES (?, now() + interval '1 hour')")
            .param(guest).update();
        jdbc.sql("""
            INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at,
                lines, total, tax, expires_at)
            SELECT gen_random_uuid(), ?, store_id, id, starts_at, ends_at, '[]'::jsonb, 9200, 0,
                now() - interval '15 minutes'
            FROM pickup_slots WHERE store_id = ? AND id IN ('cancelled', 'expired', 'held', 'paid')
            """).params(guest, store).update();
        jdbc.sql("""
            INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone,
                lines, total, tax, status, payment_status, created_at, reservation_expires_at,
                pickup_starts_at, pickup_ends_at)
            SELECT gen_random_uuid(), id, guest_session_id, slot_id, store_id, slot_id, '+250700000000',
                lines, total, tax,
                CASE slot_id WHEN 'paid' THEN 'accepted' WHEN 'cancelled' THEN 'cancelled' ELSE 'awaiting_payment' END,
                CASE slot_id WHEN 'paid' THEN 'paid' WHEN 'cancelled' THEN 'refund_pending' ELSE 'unpaid' END,
                now() - interval '20 minutes',
                now() + CASE slot_id WHEN 'held' THEN interval '10 minutes' ELSE interval '-5 minutes' END,
                pickup_starts_at, pickup_ends_at FROM quotes WHERE store_id = ?
            """).param(store).update();
    }
}
