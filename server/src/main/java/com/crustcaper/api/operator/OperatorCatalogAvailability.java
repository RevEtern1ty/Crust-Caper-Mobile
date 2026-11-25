package com.crustcaper.api.operator;

import com.crustcaper.api.ApiModels.Localized;
import com.crustcaper.api.operator.OperatorSessions.Principal;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;

@Service
final class OperatorCatalogAvailability {
    private static final Pattern CATALOG_ID = Pattern.compile("[A-Za-z0-9._:-]{1,100}");
    private static final int MAX_PATCH_BYTES = 2048;
    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final ObjectReader patchReader;

    record ProductAvailability(String sku, Localized name, boolean available) {}
    record Snapshot(String version, boolean open, List<ProductAvailability> products) {}
    private record CatalogState(String version, boolean open) {}
    private record SnapshotRow(String version, boolean open, ProductAvailability product) {}
    private record Change(String expectedVersion, String sku, boolean newValue) {}

    OperatorCatalogAvailability(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
        this.patchReader = mapper.readerFor(JsonNode.class)
            .with(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    Snapshot get(String authorization) {
        return snapshot(manager(authorization, false).storeId());
    }

    Snapshot change(String authorization, HttpServletRequest request) {
        manager(authorization, false);
        Change requested = readChange(request);
        return Objects.requireNonNull(transactions.execute(tx -> {
            Principal manager = manager(authorization, true);
            return applyLocked(manager, requested);
        }));
    }

    private Snapshot applyLocked(Principal manager, Change requested) {
        // Order reservation and the catalog importer coordinate on this same store row.
        CatalogState current = jdbc.sql("SELECT version, open FROM stores WHERE id = ? FOR UPDATE")
            .param(manager.storeId()).query((rs, row) -> new CatalogState(rs.getString("version"), rs.getBoolean("open")))
            .optional().orElseThrow(OperatorFailure::notFound);
        if (!current.version().equals(requested.expectedVersion())) {
            throw OperatorFailure.conflict("catalog_version_conflict");
        }

        boolean storeChange = requested.sku() == null;
        boolean previous = storeChange ? current.open() : productAvailable(manager.storeId(), requested.sku());
        if (previous == requested.newValue()) return snapshot(manager.storeId());

        if (!storeChange) {
            jdbc.sql("""
                UPDATE menu_products SET product = jsonb_set(product, '{available}', to_jsonb(CAST(? AS boolean)))
                WHERE store_id = ? AND sku = ?
                """).params(requested.newValue(), manager.storeId(), requested.sku()).update();
        }

        String revision = "runtime-" + UUID.randomUUID();
        jdbc.sql("UPDATE stores SET open = ?, version = ?, updated_at = clock_timestamp() WHERE id = ?")
            .params(storeChange ? requested.newValue() : current.open(), revision, manager.storeId()).update();
        jdbc.sql("""
            INSERT INTO operator_availability_events
                (store_id, operator_id, operator_username, action, sku, previous_value, new_value, previous_version, new_version)
            SELECT ?, a.id, a.username, ?, ?, ?, ?, ?, ? FROM operator_accounts a WHERE a.id = ?
            """).params(manager.storeId(), storeChange ? "store_open" : "product_available",
                requested.sku(), previous, requested.newValue(), current.version(), revision, manager.id()).update();
        return snapshot(manager.storeId());
    }

    private boolean productAvailable(String store, String sku) {
        return jdbc.sql("SELECT (product->>'available')::boolean FROM menu_products WHERE store_id = ? AND sku = ?")
            .params(store, sku).query(Boolean.class).optional().orElseThrow(OperatorFailure::notFound);
    }

    private Snapshot snapshot(String store) {
        List<SnapshotRow> rows = jdbc.sql("""
            SELECT s.version, s.open, p.sku, p.product#>>'{name,en}' AS name_en, p.product#>>'{name,rw}' AS name_rw,
                (p.product->>'available')::boolean AS product_available
            FROM stores s LEFT JOIN menu_products p ON p.store_id = s.id
            WHERE s.id = ? ORDER BY p.position, p.sku
            """).param(store).query(OperatorCatalogAvailability::snapshotRow).list();
        if (rows.isEmpty()) throw OperatorFailure.notFound();
        SnapshotRow state = rows.getFirst();
        return new Snapshot(state.version(), state.open(), rows.stream().map(SnapshotRow::product)
            .filter(Objects::nonNull).toList());
    }

    private static SnapshotRow snapshotRow(ResultSet rs, int number) throws SQLException {
        String sku = rs.getString("sku");
        ProductAvailability product = null;
        if (sku != null) {
            String en = rs.getString("name_en");
            String rw = rs.getString("name_rw");
            Boolean available = rs.getObject("product_available", Boolean.class);
            if (en == null || rw == null || available == null) {
                throw new OperatorFailure(HttpStatus.SERVICE_UNAVAILABLE, "service_unavailable");
            }
            product = new ProductAvailability(sku, new Localized(en, rw), available);
        }
        return new SnapshotRow(rs.getString("version"), rs.getBoolean("open"), product);
    }

    private Principal manager(String authorization, boolean lock) {
        Principal principal = sessions.requirePrincipal(authorization, lock);
        if (!principal.role().equals("manager")) throw OperatorFailure.forbidden();
        return principal;
    }

    private Change readChange(HttpServletRequest request) {
        if (request.getContentLengthLong() > MAX_PATCH_BYTES) throw OperatorFailure.invalid();
        try {
            byte[] body = request.getInputStream().readNBytes(MAX_PATCH_BYTES + 1);
            if (body.length == 0 || body.length > MAX_PATCH_BYTES) throw OperatorFailure.invalid();
            return parse(patchReader.readTree(body));
        } catch (IOException | JacksonException ignored) {
            throw OperatorFailure.invalid();
        }
    }

    private static Change parse(JsonNode body) {
        if (body == null || !body.isObject()) throw OperatorFailure.invalid();
        String version = identifier(body.path("expectedVersion"));
        JsonNode open = body.path("open");
        if (body.size() == 2 && open.isBoolean()) return new Change(version, null, open.booleanValue());

        JsonNode available = body.path("available");
        if (body.size() == 3 && available.isBoolean()) {
            return new Change(version, identifier(body.path("sku")), available.booleanValue());
        }
        throw OperatorFailure.invalid();
    }

    private static String identifier(JsonNode field) {
        if (!field.isString() || !CATALOG_ID.matcher(field.stringValue()).matches()) throw OperatorFailure.invalid();
        return field.stringValue();
    }
}
