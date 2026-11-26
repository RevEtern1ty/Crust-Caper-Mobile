package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.OrderService;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import com.crustcaper.api.payment.RefundDirectory;
import com.crustcaper.api.payment.RefundDirectory.ConfirmedRefund;
import com.crustcaper.api.payment.RefundDirectory.RefundRequest;
import jakarta.servlet.http.Cookie;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdfwriter.compress.CompressParameters;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.transaction.TestTransaction;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = "crustcaper.web.origin=" + OperatorReceiptCorrectionIntegrationTest.ORIGIN)
@AutoConfigureMockMvc
@ActiveProfiles("local")
@DirtiesContext
@Transactional
class OperatorReceiptCorrectionIntegrationTest {
    static final String ORIGIN = "https://receipt-test.crustcaper.invalid";
    private static final String API = "/api/v1";
    private static final String OPERATOR = API + "/operator";
    private static final String WEB = API + "/web";
    private static final String WEB_COOKIE = "__Host-crustcaper-web";
    private static final String SESSION_HEADER = "X-CrustCaper-Session";
    private static final String PASSWORD = "synthetic-receipt-correction-fixture";
    private static final String PASSWORD_HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());
    private static final String ORIGINAL_REFERENCE = "EBM/ORIGINAL";
    private static final String CORRECTION_REFERENCE = "EBM/CORRECTION";
    private static final long TOTAL = 9200;
    private static final String TRANSACTION = "94710301";
    private static final String REFUND = "94720301";
    private static final Pattern TEST_DATABASE = Pattern.compile(
        "jdbc:postgresql://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):[1-9][0-9]{0,4}/crustcaper_(?:dev|test)(?:_[a-z0-9_]+)?");
    private static final String SCHEMA = "receipt_correction_test_" + UUID.randomUUID().toString().replace("-", "");

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService orders;
    @Autowired TransactionTemplate transactions;
    @MockitoBean RefundDirectory refunds;

    @DynamicPropertySource
    static void isolatedFixtures(DynamicPropertyRegistry registry) {
        String url = System.getenv().getOrDefault("CRUSTCAPER_DB_URL", "jdbc:postgresql://127.0.0.1:55432/crustcaper_dev");
        if (!TEST_DATABASE.matcher(url).matches()) {
            throw new IllegalStateException("Run this test on a dedicated loopback crustcaper_dev or crustcaper_test database");
        }
        String scopedUrl = url + "?currentSchema=" + SCHEMA;
        registry.add("spring.datasource.url", () -> scopedUrl);
        registry.add("spring.flyway.url", () -> scopedUrl);
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.flyway.create-schemas", () -> true);
        OperatorMfaFixture.registerKey(registry);
    }

    @AfterAll
    static void removeFixtures(@Autowired JdbcClient jdbc) {
        assertThat(jdbc.sql("SELECT current_schema()").query(String.class).single()).isEqualTo(SCHEMA);
        // The class-owned schema lets committed refund and correction fixtures keep their append-only triggers.
        jdbc.sql("DROP SCHEMA " + SCHEMA + " CASCADE").update();
    }

    @Test
    void correctionRequiresVerifiedOrderRefundAndPreservesPrivateOriginal() throws Exception {
        String store = store();
        Staff manager = staff(store, "manager");
        Staff kitchen = staff(store, "kitchen");
        Staff foreignManager = staff(store(), "manager");
        Guest owner = guest();
        Guest stranger = guest();
        Browser browser = browser();
        PaidOrder paid = payForOrder(store, owner, TRANSACTION);
        UUID order = paid.id();

        byte[] original = pdf("Synthetic original receipt");
        byte[] correction = pdf("Synthetic correction receipt");
        String operatorPath = OPERATOR + "/orders/" + order;
        String nativePath = API + "/orders/" + order;
        String webPath = WEB + "/orders/" + order;
        upload(manager, operatorPath + "/receipt", ORIGINAL_REFERENCE, TOTAL, original).andExpect(status().isOk());
        assertUnavailable(manager, operatorPath, correction);
        assertPdf(nativeGet(nativePath + "/receipt", owner), "receipt", order, original);
        nativeGet(nativePath + "/receipt-correction", owner).andExpect(status().isNotFound());

        cancelOrder(manager, operatorPath);
        assertUnavailable(manager, operatorPath, correction);
        recordRefund(manager, paid.attempt(), TRANSACTION, REFUND);
        api.perform(get(OPERATOR + "/receipts").header(HttpHeaders.AUTHORIZATION, manager.bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$[0].orderId").value(order.toString()))
            .andExpect(jsonPath("$[0].correctionEligible").value(true));

        String correctionPath = operatorPath + "/receipt-correction";
        upload(kitchen, correctionPath, CORRECTION_REFERENCE, TOTAL, correction).andExpect(status().isForbidden());
        upload(foreignManager, correctionPath, CORRECTION_REFERENCE, TOTAL, correction).andExpect(status().isNotFound());
        upload(manager, correctionPath, CORRECTION_REFERENCE, TOTAL - 1, correction)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("receipt_total_mismatch"));
        upload(manager, correctionPath, ORIGINAL_REFERENCE.toLowerCase(Locale.ROOT), TOTAL, correction)
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("receipt_correction_reference_matches_original"));
        upload(manager, correctionPath, CORRECTION_REFERENCE, TOTAL, correction)
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.receiptStatus").value("corrected"))
            .andExpect(jsonPath("$.receiptReference").value(ORIGINAL_REFERENCE))
            .andExpect(jsonPath("$.correctionReference").value(CORRECTION_REFERENCE))
            .andExpect(jsonPath("$.correctionEligible").value(false));

        OffsetDateTime attached = attachmentTime(order);
        upload(manager, correctionPath, CORRECTION_REFERENCE, TOTAL, correction)
            .andExpect(status().isOk()).andExpect(jsonPath("$.correctionReference").value(CORRECTION_REFERENCE));
        upload(manager, correctionPath, CORRECTION_REFERENCE, TOTAL, pdf("Different correction bytes"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("receipt_correction_already_attached"));
        upload(manager, correctionPath, CORRECTION_REFERENCE + "-2", TOTAL, correction)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("receipt_correction_already_attached"));
        assertThat(attachmentTime(order)).isEqualTo(attached);

        nativeGet(nativePath, owner).andExpect(status().isOk())
            .andExpect(jsonPath("$.receiptStatus").value("corrected"))
            .andExpect(jsonPath("$.receiptUrl").value(nativePath + "/receipt"));
        assertPdf(nativeGet(nativePath + "/receipt", owner), "receipt", order, original);
        assertPdf(nativeGet(nativePath + "/receipt-correction", owner), "receipt-correction", order, correction);
        nativeGet(nativePath + "/receipt-correction", stranger).andExpect(status().isNotFound());
        api.perform(get(nativePath + "/receipt-correction")).andExpect(status().isUnauthorized());

        api.perform(browserGet(webPath + "/receipt-correction", browser)).andExpect(status().isNotFound());
        jdbc.sql("INSERT INTO order_read_grants (guest_session_id, order_id) VALUES (?, ?)")
            .params(browser.id(), order).update();
        api.perform(browserGet(webPath, browser)).andExpect(status().isOk())
            .andExpect(jsonPath("$.receiptStatus").value("corrected"))
            .andExpect(jsonPath("$.receiptUrl").value(webPath + "/receipt"))
            .andExpect(jsonPath("$.recoveryReadOnly").value(true));
        assertPdf(api.perform(browserGet(webPath + "/receipt", browser)), "receipt", order, original);
        assertPdf(api.perform(browserGet(webPath + "/receipt-correction", browser)), "receipt-correction", order, correction);
        api.perform(get(URI.create(ORIGIN + webPath + "/receipt-correction")).secure(true).cookie(browser.cookie()))
            .andExpect(status().isUnauthorized());

        assertThat(jdbc.sql("""
            SELECT o.status, o.payment_status, o.receipt_status, o.receipt_url,
                f.reference AS original_reference, encode(f.sha256, 'hex') AS original_hash,
                c.reference, c.provider_refund_id, c.refund_total_rwf, c.attached_by,
                encode(c.sha256, 'hex') AS correction_hash
            FROM orders o JOIN fiscal_receipts f ON f.order_id = o.id
            JOIN fiscal_receipt_corrections c ON c.order_id = o.id
            WHERE o.id = ?
            """).param(order).query().singleRow())
            .containsEntry("status", "cancelled")
            .containsEntry("payment_status", "refunded")
            .containsEntry("receipt_status", "corrected")
            .containsEntry("receipt_url", nativePath + "/receipt")
            .containsEntry("original_reference", ORIGINAL_REFERENCE)
            .containsEntry("original_hash", sha256(original))
            .containsEntry("reference", CORRECTION_REFERENCE)
            .containsEntry("provider_refund_id", REFUND)
            .containsEntry("refund_total_rwf", TOTAL)
            .containsEntry("attached_by", manager.id())
            .containsEntry("correction_hash", sha256(correction));
    }

    @Test
    void concurrentExactCorrectionRetryReadsTheCommittedAttachmentAfterWaiting() throws Exception {
        String store = store();
        Staff manager = staff(store, "manager");
        String transaction = "94710302";
        PaidOrder paid = payForOrder(store, guest(), transaction);
        String orderPath = OPERATOR + "/orders/" + paid.id();
        String correctionPath = orderPath + "/receipt-correction";
        byte[] correction = pdf("Synthetic concurrent correction");
        upload(manager, orderPath + "/receipt", ORIGINAL_REFERENCE, TOTAL, pdf("Synthetic concurrent original"))
            .andExpect(status().isOk());
        cancelOrder(manager, orderPath);
        recordRefund(manager, paid.attempt(), transaction, "94720302");
        TestTransaction.flagForCommit();
        TestTransaction.end();

        try (var executor = Executors.newSingleThreadExecutor()) {
            var retry = transactions.execute(tx -> {
                try {
                    upload(manager, correctionPath, CORRECTION_REFERENCE, TOTAL, correction)
                        .andExpect(status().isOk()).andExpect(jsonPath("$.receiptStatus").value("corrected"));
                    var pending = executor.submit(() -> upload(manager, correctionPath, CORRECTION_REFERENCE, TOTAL, correction));
                    waitForOrderLock();
                    return pending;
                } catch (Exception failure) {
                    throw new IllegalStateException("Could not coordinate concurrent correction uploads", failure);
                }
            });
            retry.get(5, TimeUnit.SECONDS).andExpect(status().isOk())
                .andExpect(jsonPath("$.receiptStatus").value("corrected"))
                .andExpect(jsonPath("$.correctionReference").value(CORRECTION_REFERENCE));
        }
        assertThat(jdbc.sql("SELECT encode(sha256, 'hex') FROM fiscal_receipt_corrections WHERE order_id = ?")
            .param(paid.id()).query(String.class).single()).isEqualTo(sha256(correction));
    }

    private void waitForOrderLock() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            jdbc.sql("SELECT pg_stat_clear_snapshot()").query((row, index) -> true).single();
            if (jdbc.sql("""
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                        AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'
                        AND pg_backend_pid() = ANY(pg_blocking_pids(pid)))
                """).query(Boolean.class).single()) return;
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("The second correction never waited for the first correction's order lock");
    }

    private PaidOrder payForOrder(String store, Guest owner, String transaction) throws Exception {
        UUID order = createOrder(store, owner);
        UUID attempt = UUID.fromString(body(api.perform(post(API + "/orders/{id}/payments", order)
            .header(HttpHeaders.AUTHORIZATION, owner.bearer()).header("Idempotency-Key", "correction-payment"))
            .andExpect(status().isOk())).path("id").asString());
        orders.settlePayment(new VerifiedPayment(attempt.toString(), transaction, TOTAL, "RWF", PaymentResult.PAID));
        return new PaidOrder(order, attempt);
    }

    private void cancelOrder(Staff manager, String orderPath) throws Exception {
        api.perform(post(orderPath + "/cancel").header(HttpHeaders.AUTHORIZATION, manager.bearer()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("refund_pending"));
    }

    private void recordRefund(Staff manager, UUID attempt, String transaction, String refund) throws Exception {
        var request = new RefundRequest(refund, transaction, TOTAL, "RWF");
        when(refunds.confirm(request)).thenReturn(Optional.of(
            new ConfirmedRefund(refund, transaction, TOTAL, "RWF", "completed-momo")
        ));
        api.perform(post(OPERATOR + "/payment-exceptions/{attempt}/{transaction}/refund", attempt, transaction)
            .header(HttpHeaders.AUTHORIZATION, manager.bearer()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(Map.of("providerRefundId", refund))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.providerRefundId").value(refund));
    }

    private void assertUnavailable(Staff manager, String orderPath, byte[] correction) throws Exception {
        upload(manager, orderPath + "/receipt-correction", CORRECTION_REFERENCE, TOTAL, correction)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("receipt_correction_not_available"));
    }

    private ResultActions upload(Staff staff, String path, String reference, long amount, byte[] pdf) throws Exception {
        return api.perform(put(path).header(HttpHeaders.AUTHORIZATION, staff.bearer())
            .header("X-Receipt-Reference", reference).header("X-Receipt-Total-RWF", Long.toString(amount))
            .contentType(MediaType.APPLICATION_PDF).content(pdf));
    }

    private ResultActions nativeGet(String path, Guest guest) throws Exception {
        return api.perform(get(path).header(HttpHeaders.AUTHORIZATION, guest.bearer()));
    }

    private MockHttpServletRequestBuilder browserGet(String path, Browser browser) {
        return get(URI.create(ORIGIN + path)).secure(true).cookie(browser.cookie())
            .header(SESSION_HEADER, browser.id().toString());
    }

    private static void assertPdf(ResultActions response, String document, UUID order, byte[] bytes) throws Exception {
        response.andExpect(status().isOk()).andExpect(content().contentType(MediaType.APPLICATION_PDF))
            .andExpect(content().bytes(bytes))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("private")))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, containsString("no-store")))
            .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"" + document + "-" + order.toString().substring(28) + ".pdf\""))
            .andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }

    private OffsetDateTime attachmentTime(UUID order) {
        return jdbc.sql("SELECT attached_at FROM fiscal_receipt_corrections WHERE order_id = ?")
            .param(order).query(OffsetDateTime.class).single();
    }

    private String store() {
        String store = "correction-test-" + UUID.randomUUID();
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
            VALUES (?, 'correction', now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).param(store).update();
        return store;
    }

    private Staff staff(String store, String role) throws Exception {
        UUID id = UUID.randomUUID();
        String username = "correction-" + id;
        byte[] seed = OperatorTotp.newSecret();
        byte[] encrypted = new OperatorTotp(OperatorMfaFixture.KEY).encryptSecret(id, seed);
        jdbc.sql("""
            INSERT INTO operator_accounts (id, store_id, username, role, password_hash, mfa_encrypted_secret)
            VALUES (?, ?, ?, ?, ?, ?)
            """).params(id, store, username, role, PASSWORD_HASH, encrypted).update();
        long counter = jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single().toEpochSecond() / 30;
        Mac mac = Mac.getInstance("HmacSHA1");
        mac.init(new SecretKeySpec(seed, "HmacSHA1"));
        byte[] hash = mac.doFinal(ByteBuffer.allocate(Long.BYTES).putLong(counter).array());
        int offset = hash[hash.length - 1] & 0x0f;
        int value = ByteBuffer.wrap(hash, offset, Integer.BYTES).getInt() & Integer.MAX_VALUE;
        String code = String.format(Locale.ROOT, "%06d", value % 1_000_000);
        JsonNode session = body(api.perform(post(OPERATOR + "/sessions").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new OperatorModels.Login(username, PASSWORD, code))))
            .andExpect(status().isCreated()));
        return new Staff(id, "Bearer " + session.path("accessToken").asString());
    }

    private Guest guest() throws Exception {
        JsonNode session = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk()));
        return new Guest("Bearer " + session.path("accessToken").asString());
    }

    private Browser browser() throws Exception {
        var response = api.perform(post(URI.create(ORIGIN + WEB + "/session")).secure(true)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CrustCaper-Web", "1"))
            .andExpect(status().isOk()).andReturn().getResponse();
        UUID id = UUID.fromString(json.readTree(response.getContentAsByteArray()).path("sessionId").asString());
        return new Browser(id, response.getCookie(WEB_COOKIE));
    }

    private UUID createOrder(String store, Guest owner) throws Exception {
        String quote = body(api.perform(post(API + "/quotes").header(HttpHeaders.AUTHORIZATION, owner.bearer())
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"storeId":"%s","slotId":"correction","lines":[{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]}
                """.formatted(store))).andExpect(status().isOk())).path("quoteId").asString();
        JsonNode order = body(api.perform(post(API + "/orders").header(HttpHeaders.AUTHORIZATION, owner.bearer())
            .header("Idempotency-Key", "correction-order").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(Map.of("quoteId", quote, "phone", "+250700000000"))))
            .andExpect(status().isOk()));
        return UUID.fromString(order.path("id").asString());
    }

    private JsonNode body(ResultActions response) throws Exception {
        return json.readTree(response.andReturn().getResponse().getContentAsByteArray());
    }

    private static byte[] pdf(String title) throws Exception {
        try (var document = new PDDocument(); var bytes = new ByteArrayOutputStream()) {
            document.addPage(new PDPage());
            document.getDocumentInformation().setTitle(title);
            document.save(bytes, CompressParameters.NO_COMPRESSION);
            return bytes.toByteArray();
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private record Staff(UUID id, String bearer) {}
    private record Guest(String bearer) {}
    private record Browser(UUID id, Cookie cookie) {}
    private record PaidOrder(UUID id, UUID attempt) {}
}
