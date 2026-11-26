package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.*;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
class Catalog {
    private static final String SLOT_QUERY = """
        SELECT id, starts_at, ends_at, capacity FROM pickup_slots WHERE store_id = ?
        """;
    private static final String UPCOMING_SLOTS_QUERY = """
        SELECT upcoming.id, upcoming.starts_at, upcoming.ends_at,
            CASE WHEN ? AND upcoming.capacity > 0 THEN (
                SELECT count(*) FROM orders
                WHERE store_id = upcoming.store_id AND slot_id = upcoming.id
                  AND pickup_reservation_occupies_slot(status, reservation_expires_at, ?)
            ) < upcoming.capacity ELSE false END AS available
        FROM (
            SELECT store_id, id, starts_at, ends_at, capacity FROM pickup_slots
            WHERE store_id = ? AND starts_at > ? ORDER BY starts_at, id LIMIT 12
        ) upcoming
        ORDER BY upcoming.starts_at, upcoming.id
        """;
    private static final String RESERVED_QUERY = """
        SELECT count(*) FROM orders WHERE store_id = ? AND slot_id = ?
          AND pickup_reservation_occupies_slot(status, reservation_expires_at, ?)
        """;

    record StoreData(Store store, String version, Instant updatedAt, int taxBasisPoints) {}
    record SlotData(String id, Instant startsAt, Instant endsAt, int capacity) {}

    private final JdbcClient jdbc;
    private final CommerceJson json;

    Catalog(JdbcClient jdbc, CommerceJson json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Menu menu(String storeId) {
        OffsetDateTime checkedAt = dbTime(Instant.now());
        StoreData store = store(storeId, false);
        List<Slot> slots = jdbc.sql(UPCOMING_SLOTS_QUERY)
            .params(store.store().open(), checkedAt, storeId, checkedAt)
            .query((rs, row) -> new Slot(rs.getString("id"), readTime(rs, "starts_at"), readTime(rs, "ends_at"),
                rs.getBoolean("available")))
            .list();
        return new Menu(store.version(), store.updatedAt(), store.store(), products(storeId, false), slots);
    }

    StoreData store(String id, boolean lock) {
        return jdbc.sql("SELECT * FROM stores WHERE id = ?" + (lock ? " FOR SHARE" : ""))
            .param(id)
            .query((rs, n) -> new StoreData(
                new Store(rs.getString("id"), json.read(rs.getString("name"), Localized.class),
                    json.read(rs.getString("area"), Localized.class), rs.getBoolean("open"),
                    json.read(rs.getString("hours"), Localized.class),
                    rs.getString("support_url"), rs.getString("directions_url")),
                rs.getString("version"), readTime(rs, "updated_at"), rs.getInt("tax_basis_points")))
            .optional().orElseThrow(ApiFailure::notFound);
    }

    List<Product> products(String storeId, boolean lock) {
        return jdbc.sql("SELECT product FROM menu_products WHERE store_id = ? ORDER BY position, sku"
                + (lock ? " FOR SHARE" : ""))
            .param(storeId)
            .query((rs, n) -> json.read(rs.getString("product"), Product.class))
            .list();
    }

    SlotData slot(String storeId, String slotId, boolean lock) {
        return jdbc.sql(SLOT_QUERY + " AND id = ?" + (lock ? " FOR UPDATE" : ""))
            .params(storeId, slotId)
            .query(Catalog::slotRow)
            .optional().orElseThrow(() -> ApiFailure.conflict("slot_unavailable"));
    }

    boolean available(Store store, SlotData slot, Instant now) {
        if (!store.open() || !slot.startsAt().isAfter(now) || slot.capacity() < 1) return false;
        long reserved = jdbc.sql(RESERVED_QUERY)
            .params(store.id(), slot.id(), dbTime(now))
            .query(Long.class)
            .single();
        return reserved < slot.capacity();
    }

    static Reorder reconcile(List<CartLine> lines, List<Product> products) {
        List<CartLine> accepted = new ArrayList<>();
        List<QuoteChange> changes = new ArrayList<>();
        for (CartLine line : lines) {
            Product product = products.stream().filter(item -> item.sku().equals(line.sku())).findFirst().orElse(null);
            if (product == null || !product.available()) {
                changes.add(new QuoteChange("unavailable", line.sku(), null, null));
                continue;
            }
            Set<String> selected = Set.copyOf(line.modifierIds());
            List<Modifier> options = product.modifiers().stream().filter(option -> selected.contains(option.id())).toList();
            if (options.size() != selected.size()) {
                changes.add(new QuoteChange("unavailable", line.sku(), null, null));
                continue;
            }
            long unitPrice = product.price();
            for (Modifier option : options) unitPrice = Math.addExact(unitPrice, option.price());
            if (unitPrice != line.unitPrice()) {
                changes.add(new QuoteChange("price", line.sku(), line.unitPrice(), unitPrice));
            }
            accepted.add(new CartLine(line.sku(), options.stream().map(Modifier::id).toList(), line.quantity(), unitPrice));
        }
        return new Reorder(List.copyOf(accepted), List.copyOf(changes));
    }

    static OffsetDateTime dbTime(Instant instant) {
        return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    static Instant readTime(ResultSet rs, String name) throws SQLException {
        return rs.getObject(name, OffsetDateTime.class).toInstant();
    }

    private static SlotData slotRow(ResultSet rs, int row) throws SQLException {
        return new SlotData(rs.getString("id"), readTime(rs, "starts_at"), readTime(rs, "ends_at"), rs.getInt("capacity"));
    }
}
