package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.ApiModels.CartLine;
import com.crustcaper.api.ApiModels.OrderInput;
import com.crustcaper.api.ApiModels.QuoteInput;
import com.crustcaper.api.OrderService;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import java.nio.ByteBuffer;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorInventoryIntegrationTest {
    private static final String API = "/api/v1";
    private static final String OPERATOR = API + "/operator";
    private static final String AVAILABILITY = OPERATOR + "/availability";
    private static final String SKU = "double-smash";
    private static final String VERSION = "inventory-initial";
    private static final String SLOT = "stock-fixture";
    private static final String PASSWORD = "synthetic-inventory-manager-fixture";
    private static final String PASSWORD_HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());
    private static final String IDEMPOTENCY_KEY = "Idempotency-Key";
    private static final long PRICE = 9200;

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService orders;

    @DynamicPropertySource
    static void mfa(DynamicPropertyRegistry registry) {
        OperatorMfaFixture.registerKey(registry);
    }

    @Test
    void namedManagerCanEnableAndRestockWithoutOverwritingAReservationOrPayment() throws Exception {
        String store = store();
        stockProduct(store);
        Staff manager = signIn(store, "manager");
        Staff kitchen = signIn(store, "kitchen");
        Staff foreignManager = signIn(store(), "manager");

        readStock(manager).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.products[0].sku").value(SKU))
            .andExpect(jsonPath("$.products[0].stock").doesNotHaveJsonPath());
        api.perform(get(AVAILABILITY)).andExpect(status().isUnauthorized());
        readStock(kitchen).andExpect(status().isForbidden());
        changeStock(kitchen, VERSION, 2, null).andExpect(status().isForbidden());
        changeStock(foreignManager, VERSION, 2, null).andExpect(status().isNotFound());
        assertThat(events(store)).isEmpty();

        var enabled = body(changeStock(manager, VERSION, 2, null).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.products[0].stock.onHand").value(2))
            .andExpect(jsonPath("$.products[0].stock.reserved").value(0))
            .andExpect(jsonPath("$.products[0].stock.revision").value(1)));
        String enabledVersion = enabled.path("version").asString();
        assertThat(enabledVersion).isNotBlank().isNotEqualTo(VERSION);
        assertThat(events(store)).containsExactly(new InventoryEvent(manager.id(), null, 2, 1));

        String attempt = holdAndStartPayment(store);
        readStock(manager).andExpect(status().isOk())
            .andExpect(jsonPath("$.products[0].stock.onHand").value(2))
            .andExpect(jsonPath("$.products[0].stock.reserved").value(1))
            .andExpect(jsonPath("$.products[0].stock.revision").value(1));
        changeStock(manager, enabledVersion, 0, 1L)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("stock_below_reserved"));
        assertThat(events(store)).containsExactly(new InventoryEvent(manager.id(), null, 2, 1));

        orders.settlePayment(new VerifiedPayment(attempt, "inventory-manager-" + attempt, PRICE, "RWF", PaymentResult.PAID));
        var consumed = body(readStock(manager).andExpect(status().isOk())
            .andExpect(jsonPath("$.products[0].stock.onHand").value(1))
            .andExpect(jsonPath("$.products[0].stock.reserved").value(0))
            .andExpect(jsonPath("$.products[0].stock.revision").value(2)));
        String afterPaymentVersion = consumed.path("version").asString();
        changeStock(manager, afterPaymentVersion, 5, 1L)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("stock_revision_conflict"));
        assertThat(jdbc.sql("SELECT on_hand FROM menu_product_inventory WHERE store_id = ? AND sku = ?")
            .params(store, SKU).query(Integer.class).single()).isOne();

        var restocked = body(changeStock(manager, afterPaymentVersion, 4, 2L).andExpect(status().isOk())
            .andExpect(jsonPath("$.products[0].stock.onHand").value(4))
            .andExpect(jsonPath("$.products[0].stock.reserved").value(0))
            .andExpect(jsonPath("$.products[0].stock.revision").value(3)));
        String restockedVersion = restocked.path("version").asString();
        assertThat(restockedVersion).isNotBlank().isNotEqualTo(afterPaymentVersion);
        changeStock(manager, restockedVersion, 4, 3L).andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(restockedVersion))
            .andExpect(jsonPath("$.products[0].stock.revision").value(3));
        assertThat(events(store)).containsExactly(
            new InventoryEvent(manager.id(), null, 2, 1),
            new InventoryEvent(manager.id(), 1, 4, 3));
    }

    private String store() {
        String id = "operator-inventory-" + UUID.randomUUID();
        assertThat(jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, ? FROM stores WHERE id = 'kigali'
            """).params(id, VERSION).update()).isOne();
        return id;
    }

    private void stockProduct(String store) {
        assertThat(jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, jsonb_set(product, '{available}', 'true')
            FROM menu_products WHERE store_id = 'kigali' AND sku = ?
            """).params(store, SKU).update()).isOne();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '35 minutes', now() + interval '45 minutes', 5)
            """).params(store, SLOT).update();
    }

    private Staff signIn(String store, String role) throws Exception {
        UUID id = UUID.randomUUID();
        String username = "stock-" + id;
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
        var response = api.perform(post(OPERATOR + "/sessions").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new OperatorModels.Login(username, PASSWORD, code))))
            .andExpect(status().isCreated());
        assertThat(jdbc.sql("SELECT mfa_verified FROM operator_sessions WHERE operator_id = ?")
            .param(id).query(Boolean.class).single()).isTrue();
        return new Staff(id, "Bearer " + body(response).path("accessToken").asString());
    }

    private String holdAndStartPayment(String store) throws Exception {
        var session = body(api.perform(post(API + "/guest-sessions")).andExpect(status().isOk()));
        String bearer = "Bearer " + session.path("accessToken").asString();
        var quote = body(api.perform(post(API + "/quotes")
            .header(HttpHeaders.AUTHORIZATION, bearer).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new QuoteInput(store, SLOT, List.of(new CartLine(SKU, List.of(), 1, PRICE))))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.changes").isEmpty()));
        var order = body(api.perform(post(API + "/orders")
            .header(HttpHeaders.AUTHORIZATION, bearer).header(IDEMPOTENCY_KEY, "stock-order")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsBytes(new OrderInput(quote.path("quoteId").asString(), "+250700000000", null))))
            .andExpect(status().isOk()));
        var payment = body(api.perform(post(API + "/orders/{id}/payments", order.path("id").asString())
            .header(HttpHeaders.AUTHORIZATION, bearer).header(IDEMPOTENCY_KEY, "stock-payment"))
            .andExpect(status().isOk()));
        return payment.path("id").asString();
    }

    private ResultActions readStock(Staff staff) throws Exception {
        return api.perform(get(AVAILABILITY).header(HttpHeaders.AUTHORIZATION, staff.bearer()));
    }

    private ResultActions changeStock(Staff staff, String expectedVersion, int onHand, Long revision) throws Exception {
        var request = json.createObjectNode().put("expectedVersion", expectedVersion)
            .put("sku", SKU).put("stockOnHand", onHand);
        if (revision == null) request.putNull("stockRevision");
        else request.put("stockRevision", revision);
        return api.perform(patch(AVAILABILITY).header(HttpHeaders.AUTHORIZATION, staff.bearer())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(request)));
    }

    private List<InventoryEvent> events(String store) {
        return jdbc.sql("""
            SELECT operator_id, previous_on_hand, new_on_hand, inventory_revision
            FROM operator_inventory_events WHERE store_id = ? AND sku = ? ORDER BY id
            """).params(store, SKU).query((row, index) -> new InventoryEvent(row.getObject("operator_id", UUID.class),
                row.getObject("previous_on_hand", Integer.class), row.getInt("new_on_hand"),
                row.getLong("inventory_revision"))).list();
    }

    private JsonNode body(ResultActions action) throws Exception {
        return json.readTree(action.andReturn().getResponse().getContentAsByteArray());
    }

    private record Staff(UUID id, String bearer) {}
    private record InventoryEvent(UUID author, Integer previous, int onHand, long revision) {}
}
