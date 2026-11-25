package com.crustcaper.api;

import static org.mockito.Mockito.doAnswer;
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
    @Autowired JdbcClient jdbc;
    @Autowired PlatformTransactionManager transactionManager;
    @MockitoSpyBean Catalog catalog;

    private final String store = "snapshot-test-" + UUID.randomUUID();

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
        jdbc.sql("DELETE FROM pickup_slots WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM menu_products WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
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
}
