package com.crustcaper.api.operator;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.regex.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;

@RestController
final class OperatorCatalogRecipeApprovals {
    private static final int MAX_APPROVAL_BYTES = 64 * 1024;
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z0-9._:-]{1,100}");

    record Approval(String storeId, String sku, String expectedVersion, String catalogVersion,
                    String recipeVersion, String allergenVersion, Instant approvedAt, Instant appliedAt) {}

    private record Review(String storeId, String expectedVersion, String catalogVersion, String sku, JsonNode facts) {}
    private record CurrentCatalog(String version, OffsetDateTime updatedAt) {}

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final ObjectReader reader;

    OperatorCatalogRecipeApprovals(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions,
                                  ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
        this.reader = mapper.reader()
            .with(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    @PostMapping(value = "/api/v1/operator/catalog/recipe-approvals", consumes = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<Approval> approve(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            HttpServletRequest request) {
        var manager = manager(authorization, false);
        Review review = read(request);
        if (!manager.storeId().equals(review.storeId())) throw OperatorFailure.forbidden();
        Approval approval = transactions.execute(status -> recordReview(authorization, review));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(approval);
    }

    private Approval recordReview(String authorization, Review review) {
        var manager = manager(authorization, true);
        if (!manager.storeId().equals(review.storeId())) throw OperatorFailure.forbidden();
        boolean named = jdbc.sql("SELECT username NOT LIKE 'demo-%' FROM operator_accounts WHERE id = ?")
            .param(manager.id()).query(Boolean.class).single();
        if (!named) throw OperatorFailure.forbidden();

        // Catalog import and availability changes lock the store before changing its version.
        CurrentCatalog current = jdbc.sql("SELECT version, updated_at FROM stores WHERE id = ? FOR UPDATE")
            .param(manager.storeId())
            .query((row, index) -> new CurrentCatalog(row.getString("version"), row.getObject("updated_at", OffsetDateTime.class)))
            .optional().orElseThrow(OperatorFailure::notFound);
        String version = current.version();
        if (!version.equals(review.expectedVersion()) && !version.equals(review.catalogVersion())) {
            throw OperatorFailure.conflict("catalog_version_conflict");
        }
        String facts = review.facts().toString();
        if (version.equals(review.expectedVersion())) {
            jdbc.sql("""
                INSERT INTO catalog_recipe_approvals
                    (store_id, expected_version, expected_updated_at, catalog_version, sku, facts, operator_id)
                VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb), ?)
                ON CONFLICT (store_id, expected_version, catalog_version, sku) DO NOTHING
                """).params(manager.storeId(), review.expectedVersion(), current.updatedAt(), review.catalogVersion(),
                    review.sku(), facts, manager.id()).update();
        }
        return jdbc.sql("""
            SELECT approved_at, applied_at, expected_updated_at, facts = CAST(? AS jsonb) AS same_facts
            FROM catalog_recipe_approvals
            WHERE store_id = ? AND expected_version = ? AND catalog_version = ? AND sku = ?
            """).params(facts, manager.storeId(), review.expectedVersion(), review.catalogVersion(), review.sku())
            .query((row, index) -> {
                if (!row.getBoolean("same_facts")) throw OperatorFailure.conflict("catalog_recipe_conflict");
                OffsetDateTime applied = row.getObject("applied_at", OffsetDateTime.class);
                OffsetDateTime expectedAt = row.getObject("expected_updated_at", OffsetDateTime.class);
                if ((version.equals(review.catalogVersion()) && applied == null)
                    || (version.equals(review.expectedVersion()) && !expectedAt.isEqual(current.updatedAt()))) {
                    throw OperatorFailure.conflict("catalog_version_conflict");
                }
                return new Approval(manager.storeId(), review.sku(), review.expectedVersion(), review.catalogVersion(),
                    review.facts().get("recipeVersion").stringValue(), review.facts().get("allergenVersion").stringValue(),
                    row.getObject("approved_at", OffsetDateTime.class).toInstant(), applied == null ? null : applied.toInstant());
            }).optional().orElseThrow(() -> OperatorFailure.conflict("catalog_version_conflict"));
    }

    private OperatorSessions.Principal manager(String authorization, boolean lock) {
        var principal = sessions.requirePrincipal(authorization, lock);
        if (!principal.role().equals("manager")) throw OperatorFailure.forbidden();
        return principal;
    }

    private Review read(HttpServletRequest request) {
        if (request.getContentLengthLong() > MAX_APPROVAL_BYTES) throw OperatorFailure.invalid();
        try {
            byte[] bytes = request.getInputStream().readNBytes(MAX_APPROVAL_BYTES + 1);
            if (bytes.length == 0 || bytes.length > MAX_APPROVAL_BYTES) throw OperatorFailure.invalid();
            JsonNode body = reader.readTree(bytes);
            if (body == null || !body.isObject() || body.size() != 6) throw OperatorFailure.invalid();
            JsonNode confirmed = body.path("crossContactConfirmed");
            JsonNode facts = body.path("facts");
            if (!confirmed.isBoolean() || !confirmed.booleanValue() || !facts.isObject() || facts.size() != 4) {
                throw OperatorFailure.invalid();
            }
            identifier(facts.path("recipeVersion"));
            identifier(facts.path("allergenVersion"));
            validateLocalizedList(facts.path("ingredients"));
            validateLocalizedList(facts.path("allergens"));
            String previous = identifier(body.path("expectedVersion"));
            String next = identifier(body.path("catalogVersion"));
            if (previous.equals(next)) throw OperatorFailure.invalid();
            return new Review(identifier(body.path("storeId")), previous, next, identifier(body.path("sku")), facts);
        } catch (IOException | JacksonException ignored) {
            throw OperatorFailure.invalid();
        }
    }

    private static String identifier(JsonNode value) {
        if (!value.isString() || !IDENTIFIER.matcher(value.stringValue()).matches()) throw OperatorFailure.invalid();
        return value.stringValue();
    }

    private static void validateLocalizedList(JsonNode values) {
        if (!values.isArray()) throw OperatorFailure.invalid();
        for (JsonNode value : values) {
            if (!value.isObject() || value.size() != 2 || !validText(value.path("en")) || !validText(value.path("rw"))) {
                throw OperatorFailure.invalid();
            }
        }
    }

    private static boolean validText(JsonNode value) {
        if (!value.isString()) return false;
        String text = value.stringValue();
        return !text.isBlank() && text.codePointCount(0, text.length()) <= 4096
            && text.codePoints().noneMatch(codePoint -> codePoint == 0 || codePoint >= 0xD800 && codePoint <= 0xDFFF);
    }
}
