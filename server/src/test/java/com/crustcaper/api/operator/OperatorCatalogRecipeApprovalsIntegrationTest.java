package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorCatalogRecipeApprovalsIntegrationTest {
    private static final String ENDPOINT = "/api/v1/operator/catalog/recipe-approvals";
    private static final String PROPOSAL = """
        {
          "storeId":"%s","expectedVersion":"catalog-1","catalogVersion":"catalog-2","sku":"sandwich",
          "crossContactConfirmed":true,
          "facts":{"recipeVersion":"recipe-2","allergenVersion":"allergen-2",
                   "ingredients":[{"en":"Wheat","rw":"Ingano"}],"allergens":[{"en":"Gluten","rw":"Guluteni"}]}
        }
        """;

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;

    @DynamicPropertySource
    static void mfa(DynamicPropertyRegistry registry) {
        OperatorMfaFixture.registerKey(registry);
    }

    @Test
    void onlyAnAuthenticatedNamedManagerCanConfirmTheirOwnStoreWithTheChecklist() throws Exception {
        String own = store();
        String other = store();
        Staff manager = staff(own, "manager", true, false);
        String proposal = PROPOSAL.formatted(own);
        approve(null, proposal).andExpect(status().isUnauthorized())
            .andExpect(header().string(HttpHeaders.WWW_AUTHENTICATE, "Bearer"));
        approve(staff(own, "manager", false, false), proposal).andExpect(status().isUnauthorized());
        approve(staff(own, "kitchen", true, false), proposal).andExpect(status().isForbidden());
        approve(staff(own, "manager", true, true), proposal).andExpect(status().isForbidden());
        approve(manager, PROPOSAL.formatted(other)).andExpect(status().isForbidden());
        approve(manager, proposal.replace("\"crossContactConfirmed\":true", "\"crossContactConfirmed\":false"))
            .andExpect(status().isBadRequest());
        approve(manager, proposal.replace("\"sku\":\"sandwich\"", "\"sku\":\"sandwich\",\"sku\":\"other\""))
            .andExpect(status().isBadRequest());
        assertThat(approvalCount(own)).isZero();

        approve(manager, proposal).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.recipeVersion").value("recipe-2"))
            .andExpect(jsonPath("$.allergenVersion").value("allergen-2"));
        assertThat(jdbc.sql("SELECT operator_id FROM catalog_recipe_approvals WHERE store_id = ?")
            .param(own).query(UUID.class).single()).isEqualTo(manager.id());
        assertThat(approvalCount(other)).isZero();
    }

    @Test
    void exactRetriesPreserveAuthorAndTimestampAndConflictingOrStaleReviewsFail() throws Exception {
        String store = store();
        Staff author = staff(store, "manager", true, false);
        Staff later = staff(store, "manager", true, false);
        String proposal = PROPOSAL.formatted(store);
        String first = approve(author, proposal).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        String retry = approve(later, proposal).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(retry).isEqualTo(first);
        assertThat(approvalCount(store)).isOne();
        approve(later, proposal.replace("Wheat", "Rice")).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("catalog_recipe_conflict"));

        jdbc.sql("UPDATE stores SET version = 'catalog-2' WHERE id = ?").param(store).update();
        approve(later, proposal).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("catalog_version_conflict"));
        jdbc.sql("UPDATE catalog_recipe_approvals SET applied_at = clock_timestamp() WHERE store_id = ?").param(store).update();
        approve(later, proposal).andExpect(status().isOk()).andExpect(jsonPath("$.appliedAt").isString());
        jdbc.sql("UPDATE stores SET version = 'catalog-3' WHERE id = ?").param(store).update();
        approve(later, proposal).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("catalog_version_conflict"));
        assertThat(jdbc.sql("SELECT operator_id FROM catalog_recipe_approvals WHERE store_id = ?")
            .param(store).query(UUID.class).single()).isEqualTo(author.id());
    }

    private ResultActions approve(Staff staff, String json) throws Exception {
        MockHttpServletRequestBuilder request = post(ENDPOINT).contentType(MediaType.APPLICATION_JSON).content(json);
        if (staff != null) request.header(HttpHeaders.AUTHORIZATION, "Bearer " + staff.token());
        return api.perform(request);
    }

    private int approvalCount(String store) {
        return jdbc.sql("SELECT count(*) FROM catalog_recipe_approvals WHERE store_id = ?")
            .param(store).query(Integer.class).single();
    }

    private String store() {
        String id = "recipe-" + UUID.randomUUID();
        jdbc.sql("INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version) "
            + "VALUES (?, '{}', '{}', '{}', false, 0, 'catalog-1')").param(id).update();
        return id;
    }

    private Staff staff(String store, String role, boolean verified, boolean demo) throws NoSuchAlgorithmException {
        UUID id = UUID.randomUUID();
        String token = "x" + UUID.randomUUID().toString().replace("-", "") + "testAbCdEf";
        String tokenHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(token.getBytes(StandardCharsets.US_ASCII)));
        jdbc.sql("INSERT INTO operator_accounts (id, store_id, username, role, password_hash, mfa_encrypted_secret) "
            + "VALUES (?, ?, ?, ?, 'fixture', ?)")
            .params(id, store, (demo ? "demo-" : "recipe-manager-") + id, role, OperatorMfaFixture.encryptedSeed(id)).update();
        jdbc.sql("INSERT INTO operator_sessions (token_hash, operator_id, expires_at, mfa_verified) "
            + "VALUES (?, ?, now() + interval '10 minutes', ?)")
            .params(tokenHash, id, verified).update();
        return new Staff(id, token);
    }

    private record Staff(UUID id, String token) {}
}
