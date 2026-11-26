package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.*;

import com.crustcaper.api.payment.PaymentGateway.CheckoutChannel;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
class Catalog {
    private static final int MENU_SLOT_LIMIT = 12;
    private static final String SALE_PRODUCT = """
        CASE WHEN catalog_sale_active(p.sale_hours, :soldAt)
            AND catalog_product_has_stock(p.store_id, p.sku, :soldAt) THEN p.product
            ELSE jsonb_set(p.product, '{available}', 'false'::jsonb) END AS product
        """;
    private static final String MENU_SALE_PRODUCT = SALE_PRODUCT + """
        , CASE WHEN p.product->'available' = 'true'::jsonb AND p.sale_hours <> '[]'::jsonb
            AND catalog_product_has_stock(p.store_id, p.sku, :soldAt)
            THEN catalog_next_sale_change(p.sale_hours, :soldAt) END AS next_sale_change
        """;
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
            WHERE store_id = ? AND starts_at > ? ORDER BY starts_at, id LIMIT %d
        ) upcoming
        ORDER BY upcoming.starts_at, upcoming.id
        """.formatted(MENU_SLOT_LIMIT);
    private static final String NEXT_AVAILABLE_SLOT_QUERY = """
        SELECT slot.id, slot.starts_at, slot.ends_at, true AS available
        FROM pickup_slots slot
        WHERE slot.store_id = :store AND slot.starts_at >= :lastStart
          AND (slot.starts_at, slot.id) > (:lastStart, :lastId) AND slot.capacity > 0
          AND (
              SELECT count(*) FROM (
                  SELECT 1 FROM orders
                  WHERE store_id = slot.store_id AND slot_id = slot.id
                    AND pickup_reservation_occupies_slot(status, reservation_expires_at, :checkedAt)
                  LIMIT slot.capacity
              ) occupied
          ) < slot.capacity
        ORDER BY slot.starts_at, slot.id LIMIT 1
        """;
    private static final String RESERVED_QUERY = """
        SELECT count(*) FROM orders WHERE store_id = ? AND slot_id = ?
          AND pickup_reservation_occupies_slot(status, reservation_expires_at, ?)
        """;

    record StoreData(Store store, String version, Instant updatedAt, int taxBasisPoints) {}
    record QuoteCatalog(StoreData store, List<Product> products) {}
    record SlotData(String id, Instant startsAt, Instant endsAt, int capacity) {}
    private record MenuProduct(Product product, Instant nextSaleChange) {}

    private final JdbcClient jdbc;
    private final CommerceJson json;

    Catalog(JdbcClient jdbc, CommerceJson json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Menu menu(String storeId, CheckoutChannel channel) {
        OffsetDateTime checkedAt = dbTime(databaseNow());
        StoreData store = store(storeId, false);
        List<Slot> slots = jdbc.sql(UPCOMING_SLOTS_QUERY)
            .params(store.store().open(), checkedAt, storeId, checkedAt)
            .query(Catalog::menuSlotRow)
            .list();
        if (store.store().open() && slots.size() == MENU_SLOT_LIMIT && slots.stream().noneMatch(Slot::available)) {
            // Keep the normal window when it contains a choice. Otherwise seek forward in the same snapshot.
            Slot last = slots.getLast();
            Slot available = jdbc.sql(NEXT_AVAILABLE_SLOT_QUERY)
                .param("store", storeId).param("lastStart", dbTime(last.startsAt())).param("lastId", last.id())
                .param("checkedAt", checkedAt).query(Catalog::menuSlotRow).optional().orElse(null);
            if (available != null) {
                slots = new ArrayList<>(slots);
                slots.set(MENU_SLOT_LIMIT - 1, available);
            }
        }
        List<MenuProduct> products = productRows(MENU_SALE_PRODUCT, storeId, channel, checkedAt, false)
            .query((rs, n) -> {
                OffsetDateTime nextSaleChange = rs.getObject("next_sale_change", OffsetDateTime.class);
                return new MenuProduct(json.read(rs.getString("product"), Product.class),
                    nextSaleChange == null ? null : nextSaleChange.toInstant());
            }).list();
        Instant nextSaleChange = products.stream().map(MenuProduct::nextSaleChange)
            .filter(Objects::nonNull).min(Instant::compareTo).orElse(null);
        return new Menu(store.version(), store.updatedAt(), checkedAt.toInstant(), nextSaleChange,
            store.store(), products.stream().map(MenuProduct::product).toList(), slots);
    }

    private static Slot menuSlotRow(ResultSet rs, int row) throws SQLException {
        return new Slot(rs.getString("id"), readTime(rs, "starts_at"), readTime(rs, "ends_at"), rs.getBoolean("available"));
    }

    StoreData store(String id, boolean lock) {
        return jdbc.sql("SELECT * FROM stores WHERE id = ?" + (lock ? " FOR SHARE" : ""))
            .param(id)
            .query((rs, n) -> storeRow(rs))
            .optional().orElseThrow(ApiFailure::notFound);
    }

    QuoteCatalog quoteCatalog(String storeId, List<CartLine> lines, CheckoutChannel channel, Instant now) {
        // One statement ties the version and selected products to the same catalog snapshot.
        return jdbc.sql("""
            SELECT s.*,
            """ + SALE_PRODUCT + """
            FROM stores s
            LEFT JOIN menu_products p ON p.store_id = s.id AND p.sku IN (:skus)
                AND :channel = ANY(p.sale_channels)
            WHERE s.id = :storeId ORDER BY p.position, p.sku
            """)
            .param("storeId", storeId).param("skus", lines.stream().map(CartLine::sku).distinct().toList())
            .param("channel", channel.name().toLowerCase(Locale.ROOT)).param("soldAt", dbTime(now))
            .query(rs -> {
                if (!rs.next()) throw ApiFailure.notFound();
                StoreData store = storeRow(rs);
                List<Product> products = new ArrayList<>();
                do {
                    String product = rs.getString("product");
                    if (product != null) products.add(json.read(product, Product.class));
                } while (rs.next());
                return new QuoteCatalog(store, products);
            });
    }

    private StoreData storeRow(ResultSet rs) throws SQLException {
        return new StoreData(
            new Store(rs.getString("id"), json.read(rs.getString("name"), Localized.class),
                json.read(rs.getString("area"), Localized.class), rs.getBoolean("open"),
                json.read(rs.getString("hours"), Localized.class),
                rs.getString("support_url"), rs.getString("directions_url")),
            rs.getString("version"), readTime(rs, "updated_at"), rs.getInt("tax_basis_points"));
    }

    List<Product> products(String storeId, CheckoutChannel channel, Instant now, boolean lock) {
        return productRows(SALE_PRODUCT, storeId, channel, dbTime(now), lock)
            .query((rs, n) -> json.read(rs.getString("product"), Product.class)).list();
    }

    private JdbcClient.StatementSpec productRows(String projection, String storeId, CheckoutChannel channel,
                                                  OffsetDateTime checkedAt, boolean lock) {
        return jdbc.sql("SELECT " + projection + """
                FROM menu_products p WHERE p.store_id = :storeId AND :channel = ANY(p.sale_channels)
                ORDER BY p.position, p.sku
                """ + (lock ? " FOR SHARE" : ""))
            .param("storeId", storeId).param("channel", channel.name().toLowerCase(Locale.ROOT))
            .param("soldAt", checkedAt);
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

    static Map<String, Integer> inventoryQuantities(List<CartLine> lines) {
        Map<String, Integer> quantities = new TreeMap<>();
        for (CartLine line : lines) {
            quantities.merge(line.sku(), line.quantity(), Math::addExact);
        }
        return quantities;
    }

    List<String> lockInventory(String store, Set<String> skus) {
        if (skus.isEmpty()) return List.of();
        return jdbc.sql("""
            SELECT sku FROM menu_product_inventory WHERE store_id = :store AND sku IN (:skus)
            ORDER BY sku FOR UPDATE
            """).param("store", store).param("skus", skus).query(String.class).list();
    }

    private Set<String> insufficientInventory(String store, Map<String, Integer> quantities, Instant now) {
        if (quantities.isEmpty()) return Set.of();
        return jdbc.sql("""
            SELECT sku, on_hand - catalog_reserved_product_units(store_id, sku, :checkedAt) AS remaining
            FROM menu_product_inventory WHERE store_id = :store AND sku IN (:skus)
            """).param("checkedAt", dbTime(now)).param("store", store).param("skus", quantities.keySet())
            .query(rs -> {
                Set<String> unavailable = new HashSet<>();
                while (rs.next()) {
                    String sku = rs.getString("sku");
                    if (quantities.get(sku) > rs.getLong("remaining")) unavailable.add(sku);
                }
                return unavailable;
            });
    }

    void consumeInventory(String store, List<String> tracked, Map<String, Integer> quantities) {
        for (String sku : tracked) {
            jdbc.sql("""
                UPDATE menu_product_inventory SET on_hand = on_hand - ?, revision = revision + 1
                WHERE store_id = ? AND sku = ?
                """).params(quantities.get(sku), store, sku).update();
        }
    }

    Reorder reconcile(String store, List<CartLine> lines, List<Product> products, String catalogVersion, Instant now) {
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
            SoldItem soldItem = catalogVersion == null ? null
                : new SoldItem(catalogVersion, product.name(), product.ingredients(), product.allergens(), options);
            accepted.add(new CartLine(line.sku(), options.stream().map(Modifier::id).toList(), line.quantity(), unitPrice, soldItem));
        }
        Set<String> insufficient = insufficientInventory(store, inventoryQuantities(accepted), now);
        if (!insufficient.isEmpty()) {
            changes.removeIf(change -> change.kind().equals("price") && insufficient.contains(change.sku()));
            for (CartLine line : accepted) {
                if (insufficient.contains(line.sku())) changes.add(new QuoteChange("unavailable", line.sku(), null, null));
            }
            accepted.removeIf(line -> insufficient.contains(line.sku()));
        }
        return new Reorder(List.copyOf(accepted), List.copyOf(changes));
    }

    static OffsetDateTime dbTime(Instant instant) {
        return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    Instant databaseNow() {
        return jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single().toInstant();
    }

    static Instant readTime(ResultSet rs, String name) throws SQLException {
        return rs.getObject(name, OffsetDateTime.class).toInstant();
    }

    private static SlotData slotRow(ResultSet rs, int row) throws SQLException {
        return new SlotData(rs.getString("id"), readTime(rs, "starts_at"), readTime(rs, "ends_at"), rs.getInt("capacity"));
    }
}
