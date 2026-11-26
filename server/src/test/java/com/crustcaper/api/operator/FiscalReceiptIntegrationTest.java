package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import jakarta.servlet.ServletInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class FiscalReceiptIntegrationTest {
    private static final String API = "/api/v1";
    private static final String OPERATOR = API + "/operator";
    private static final String PHONE = "+250700000000";
    private static final String PASSWORD = "synthetic-receipt-qa";
    private static final String HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());
    private static final String REF = "X-Receipt-Reference";
    private static final String TOTAL = "X-Receipt-Total-RWF";
    private static final String KEY = "Idempotency-Key";
    private static final byte[] PDF = "%PDF-1.7\nSynthetic marker fixture\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OperatorController operatorController;

    private String store;
    private final List<String> stores = new ArrayList<>();
    private final List<UUID> guests = new ArrayList<>();

    private record Manager(UUID id, String bearer) {}
    private record Guest(UUID id, String bearer) {}
    private record Order(UUID id, Guest owner) {}

    @BeforeEach
    void fixture() {
        store = store();
    }

    @AfterEach
    void removeOnlyFixtures() {
        for (String fixture : stores) {
            jdbc.sql("DELETE FROM fiscal_receipts WHERE store_id = ?").param(fixture).update();
            jdbc.sql("DELETE FROM operator_order_events WHERE store_id = ?").param(fixture).update();
            jdbc.sql("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operator_accounts WHERE store_id = ?)")
                .param(fixture).update();
            jdbc.sql("DELETE FROM operator_accounts WHERE store_id = ?").param(fixture).update();
            jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
                .param(fixture).update();
            for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
                jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(fixture).update();
            }
            jdbc.sql("DELETE FROM stores WHERE id = ?").param(fixture).update();
        }
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void managerQueuePrioritizesPendingAndPrivateDownloadIsAvailableToOwnerAndConfirmedGrant() throws Exception {
        Manager manager = staff(store, "manager");
        Manager kitchen = staff(store, "kitchen");
        Order pending = order(store, true);
        Order issued = order(store, true);
        Order unpaid = order(store, false);
        Order elsewhere = order(store(), true);
        jdbc.sql("UPDATE orders SET status = 'collected' WHERE id = ?").param(pending.id()).update();
        upload(manager.bearer(), issued.id(), "EBM/002", "9200", PDF).andExpect(status().isOk());
        api.perform(get(OPERATOR + "/receipts").header(HttpHeaders.AUTHORIZATION, kitchen.bearer()))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
        api.perform(get(OPERATOR + "/receipts").header(HttpHeaders.AUTHORIZATION, manager.bearer()))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.length()").value(2))
            .andExpect(jsonPath("$[0].orderId").value(pending.id().toString()))
            .andExpect(jsonPath("$[0].status").value("collected")).andExpect(jsonPath("$[0].receiptStatus").value("pending"))
            .andExpect(jsonPath("$[0].receiptReference").isEmpty())
            .andExpect(jsonPath("$[1].orderId").value(issued.id().toString()))
            .andExpect(jsonPath("$[1].receiptReference").value("EBM/002"));
        upload(manager.bearer(), unpaid.id(), "EBM/003", "9200", PDF).andExpect(status().isNotFound());
        upload(manager.bearer(), elsewhere.id(), "EBM/004", "9200", PDF).andExpect(status().isNotFound());

        String path = receiptPath(pending.id());
        api.perform(get(path).header(HttpHeaders.AUTHORIZATION, pending.owner().bearer())).andExpect(status().isNotFound());
        upload(manager.bearer(), pending.id(), "EBM/001", "9200", PDF).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("collected")).andExpect(jsonPath("$.receiptStatus").value("issued"));
        api.perform(get(API + "/orders/" + pending.id()).header(HttpHeaders.AUTHORIZATION, pending.owner().bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.receiptUrl").value(path))
            .andExpect(jsonPath("$.receiptStatus").value("issued"));

        Guest confirmed = guest();
        Guest unrelated = guest();
        jdbc.sql("INSERT INTO order_read_grants (guest_session_id, order_id) VALUES (?, ?)")
            .params(confirmed.id(), pending.id()).update();
        for (String bearer : List.of(pending.owner().bearer(), confirmed.bearer())) {
            api.perform(get(path).header(HttpHeaders.AUTHORIZATION, bearer))
                .andExpect(status().isOk()).andExpect(content().bytes(PDF))
                .andExpect(content().contentType(MediaType.APPLICATION_PDF))
                .andExpect(header().string(HttpHeaders.CONTENT_LENGTH, Integer.toString(PDF.length)))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("private")))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store")))
                .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION, containsString("attachment")))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"));
        }
        api.perform(get(path)).andExpect(status().isUnauthorized());
        api.perform(get(path).header(HttpHeaders.AUTHORIZATION, unrelated.bearer())).andExpect(status().isNotFound());
        api.perform(get(path).header(HttpHeaders.AUTHORIZATION, manager.bearer())).andExpect(status().isUnauthorized());
    }

    @Test
    void handoffWithoutReceiptStaysAheadOfNewPendingOrdersAtTheQueueLimit() throws Exception {
        Manager manager = staff(store, "manager");
        Order laterHandoff = order(store, true);
        Order earlierHandoff = order(store, true);
        Order pending = order(store, true);
        Order issued = order(store, true);
        collect(manager, earlierHandoff);
        collect(manager, laterHandoff);
        jdbc.sql("""
            UPDATE operator_order_events SET occurred_at = occurred_at - interval '2 hours'
            WHERE order_id = ? AND store_id = ? AND requested_status = 'collected' AND outcome = 'changed'
            """).params(earlierHandoff.id(), store).update();
        upload(manager.bearer(), issued.id(), "EBM-ISSUED", "9200", PDF).andExpect(status().isOk());

        api.perform(get(OPERATOR + "/receipts").header(HttpHeaders.AUTHORIZATION, manager.bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(4))
            .andExpect(jsonPath("$[0].orderId").value(earlierHandoff.id().toString()))
            .andExpect(jsonPath("$[1].orderId").value(laterHandoff.id().toString()))
            .andExpect(jsonPath("$[2].orderId").value(pending.id().toString()))
            .andExpect(jsonPath("$[3].orderId").value(issued.id().toString()));

        jdbc.sql("UPDATE pickup_slots SET capacity = 104 WHERE store_id = ? AND id = 'receipt'").param(store).update();
        for (int i = 0; i < 100; i++) order(store, true);
        api.perform(get(OPERATOR + "/receipts").header(HttpHeaders.AUTHORIZATION, manager.bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(100))
            .andExpect(jsonPath("$[0].orderId").value(earlierHandoff.id().toString()))
            .andExpect(jsonPath("$[1].orderId").value(laterHandoff.id().toString()))
            .andExpect(jsonPath("$[99].receiptStatus").value("pending"));
    }

    @Test
    void exactReplayPreservesOriginalDocumentAndAuditWithUniqueReceiptReferencePerStore() throws Exception {
        Manager original = staff(store, "manager");
        Manager another = staff(store, "manager");
        Order first = order(store, true);
        Order second = order(store, true);
        upload(original.bearer(), first.id(), "EbM-abc/007", "9200", PDF).andExpect(status().isOk());
        upload(another.bearer(), first.id(), "EbM-abc/007", "9200", PDF).andExpect(status().isOk());
        upload(another.bearer(), first.id(), "EbM-abc/007", "9201", PDF).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("receipt_total_mismatch"));
        byte[] replacement = "%PDF-1.4\nDifferent synthetic file\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);
        upload(another.bearer(), first.id(), "EbM-abc/007", "9200", replacement).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("receipt_already_issued"));
        upload(another.bearer(), second.id(), "EBM-ABC/007", "9200", PDF).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("receipt_reference_in_use"));
        assertThat(jdbc.sql("SELECT attached_by FROM fiscal_receipts WHERE order_id = ?")
            .param(first.id()).query(UUID.class).single()).isEqualTo(original.id());
        assertThat(jdbc.sql("SELECT document FROM fiscal_receipts WHERE order_id = ?")
            .param(first.id()).query((rs, n) -> rs.getBytes(1)).single()).isEqualTo(PDF);
        assertThat(jdbc.sql("SELECT count(*) FROM fiscal_receipts WHERE store_id = ?")
            .param(store).query(Long.class).single()).isEqualTo(1);
        String different = store();
        Manager otherStore = staff(different, "manager");
        upload(otherStore.bearer(), order(different, true).id(), "EBM-ABC/007", "9200", PDF).andExpect(status().isOk());
    }

    @Test
    void concurrentUploadsOfOneStoreReferenceIssueOnlyOneReceipt() throws Exception {
        Manager manager = staff(store, "manager");
        Order firstOrder = order(store, true);
        Order secondOrder = order(store, true);
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                return upload(manager.bearer(), firstOrder.id(), "EbM-998", "9200", PDF).andReturn().getResponse().getStatus();
            });
            var second = pool.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                return upload(manager.bearer(), secondOrder.id(), "EBM-998", "9200", PDF).andReturn().getResponse().getStatus();
            });
            start.countDown();
            assertThat(List.of(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(200, 409);
        }
        assertThat(jdbc.sql("SELECT receipt_status FROM orders WHERE store_id = ?")
            .param(store).query(String.class).list()).containsExactlyInAnyOrder("issued", "pending");
        assertThat(jdbc.sql("SELECT count(*) FROM fiscal_receipts WHERE store_id = ?")
            .param(store).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    void authorizationAndValidationPrecedeReadsAndWrongPdfOrOverflowCannotChangeReceiptState() throws Exception {
        Order order = order(store, true);
        Manager manager = staff(store, "manager");
        Manager kitchen = staff(store, "kitchen");
        MockHttpServletRequest unread = new MockHttpServletRequest() {
            @Override
            public ServletInputStream getInputStream() {
                throw new AssertionError("PDF input was read before authorization");
            }
        };
        unread.addHeader(REF, "RECEIPT-7");
        unread.addHeader(TOTAL, "9200");
        assertThatThrownBy(() -> operatorController.attachReceipt(null, order.id().toString(), unread))
            .isInstanceOf(OperatorFailure.class).hasMessage("unauthenticated");
        assertThatThrownBy(() -> operatorController.attachReceipt(kitchen.bearer(), order.id().toString(), unread))
            .isInstanceOf(OperatorFailure.class).hasMessage("forbidden");
        unread.removeHeader(TOTAL);
        unread.addHeader(TOTAL, "100");
        assertThatThrownBy(() -> operatorController.attachReceipt(manager.bearer(), order.id().toString(), unread))
            .isInstanceOf(OperatorFailure.class).hasMessage("receipt_total_mismatch");

        api.perform(put(operatorPath(order.id())).header(HttpHeaders.AUTHORIZATION, manager.bearer())
            .header(REF, "RECEIPT-7").header(TOTAL, "9200").contentType(MediaType.TEXT_PLAIN).content(PDF))
            .andExpect(status().isUnsupportedMediaType()).andExpect(jsonPath("$.code").value("unsupported_media_type"));
        upload(manager.bearer(), order.id(), "../unsafe", "9200", PDF).andExpect(status().isBadRequest());
        upload(manager.bearer(), order.id(), "RECEIPT-7", "9200",
            "%PDF-1.7\nTruncated".getBytes(StandardCharsets.US_ASCII)).andExpect(status().isBadRequest());
        upload(manager.bearer(), order.id(), "RECEIPT-7", "9200", new byte[ReceiptPdf.LIMIT + 1])
            .andExpect(status().is(413)).andExpect(jsonPath("$.code").value("receipt_too_large"));

        MockHttpServletRequest chunked = new MockHttpServletRequest() {
            @Override
            public long getContentLengthLong() { return -1; }
        };
        chunked.setContentType(MediaType.APPLICATION_PDF_VALUE);
        chunked.addHeader(REF, "RECEIPT-7");
        chunked.addHeader(TOTAL, "9200");
        chunked.setContent(new byte[ReceiptPdf.LIMIT + 50]);
        assertThatThrownBy(() -> operatorController.attachReceipt(manager.bearer(), order.id().toString(), chunked))
            .isInstanceOf(OperatorFailure.class).hasMessage("receipt_too_large");
        assertThat(jdbc.sql("SELECT receipt_status FROM orders WHERE id = ?")
            .param(order.id()).query(String.class).single()).isEqualTo("pending");
        assertThat(jdbc.sql("SELECT count(*) FROM fiscal_receipts WHERE order_id = ?")
            .param(order.id()).query(Long.class).single()).isZero();
    }

    private String store() {
        String id = "receipt-test-" + UUID.randomUUID();
        stores.add(id);
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(id).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(id).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'receipt', now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).param(id).update();
        return id;
    }

    private Guest guest() throws Exception {
        String token = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk())).path("accessToken").asString();
        UUID id = jdbc.sql("""
            SELECT guest_session_id FROM guest_access_tokens WHERE token_hash = encode(sha256(convert_to(?, 'UTF8')), 'hex')
            """).param(token).query(UUID.class).single();
        guests.add(id);
        return new Guest(id, "Bearer " + token);
    }

    private Manager staff(String location, String role) throws Exception {
        UUID id = UUID.randomUUID();
        String username = "receipt-" + id;
        jdbc.sql("INSERT INTO operator_accounts (id, store_id, username, role, password_hash) VALUES (?, ?, ?, ?, ?)")
            .params(id, location, username, role, HASH).update();
        String token = body(api.perform(post(OPERATOR + "/sessions").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new OperatorModels.Login(username, PASSWORD))))
            .andExpect(status().isCreated())).path("accessToken").asString();
        return new Manager(id, "Bearer " + token);
    }

    private Order order(String location, boolean paid) throws Exception {
        Guest guest = guest();
        String quote = body(api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, guest.bearer())
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"storeId":"%s","slotId":"receipt","lines":[{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]}
                """.formatted(location))).andExpect(status().isOk())).path("quoteId").asString();
        UUID id = UUID.fromString(body(api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, guest.bearer())
            .header(KEY, "order").contentType(MediaType.APPLICATION_JSON)
            .content("{\"quoteId\":\"" + quote + "\",\"phone\":\"" + PHONE + "\"}"))
            .andExpect(status().isOk())).path("id").asString());
        if (paid) {
            String attempt = body(api.perform(post(API + "/orders/" + id + "/payments")
                .header(HttpHeaders.AUTHORIZATION, guest.bearer()).header(KEY, "payment")).andExpect(status().isOk()))
                .path("id").asString();
            api.perform(post(API + "/local/orders/" + id + "/payments/" + attempt + "/result")
                .header(HttpHeaders.AUTHORIZATION, guest.bearer()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"paid\"}")).andExpect(status().isOk());
        }
        return new Order(id, guest);
    }

    private ResultActions upload(String bearer, UUID order, String reference, String total, byte[] pdf) throws Exception {
        return api.perform(put(operatorPath(order)).header(HttpHeaders.AUTHORIZATION, bearer)
            .header(REF, reference).header(TOTAL, total).contentType(MediaType.APPLICATION_PDF).content(pdf));
    }

    private void collect(Manager manager, Order order) throws Exception {
        String pickupCode = jdbc.sql("SELECT pickup_code FROM orders WHERE id = ?")
            .param(order.id()).query(String.class).single();
        for (String status : List.of("preparing", "ready", "collected")) {
            api.perform(post(OPERATOR + "/orders/" + order.id() + "/status").header(HttpHeaders.AUTHORIZATION, manager.bearer())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(
                    new OperatorModels.StatusInput(status, status.equals("collected") ? pickupCode : null))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value(status));
        }
    }

    private static String operatorPath(UUID order) { return OPERATOR + "/orders/" + order + "/receipt"; }
    private static String receiptPath(UUID order) { return API + "/orders/" + order + "/receipt"; }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }
}
