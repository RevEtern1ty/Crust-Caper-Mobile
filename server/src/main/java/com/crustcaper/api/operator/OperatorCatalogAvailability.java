package com.crustcaper.api.operator;

import com.crustcaper.api.ApiModels.Localized;
import com.crustcaper.api.operator.OperatorSessions.Principal;
import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;

@Service
class OperatorCatalogAvailability {
    private static final Pattern CATALOG_ID = Pattern.compile("[A-Za-z0-9._:-]{1,100}");
    private static final Pattern SCHEDULE_DATE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
    private static final Pattern SCHEDULE_TIME = Pattern.compile("[0-9]{2}:[0-9]{2}");
    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    private static final int SLOT_MINUTES = 10;
    private static final int MAX_PATCH_BYTES = 2048;
    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final ObjectReader patchReader;

    record ProductAvailability(String sku, Localized name, boolean available,
                               @JsonInclude(JsonInclude.Include.NON_NULL) Inventory stock) {}
    record Inventory(int onHand, long reserved, long revision) {}
    record SlotAvailability(String id, Instant startsAt, Instant endsAt, int capacity, int reserved) {}
    record Snapshot(String version, boolean open, List<ProductAvailability> products, List<SlotAvailability> slots) {}
    private record CatalogState(String version, boolean open) {}
    private record SnapshotRow(String version, boolean open, ProductAvailability product) {}
    private record LockedSlot(OffsetDateTime startsAt, int capacity) {}
    private sealed interface Change permits AvailabilityChange, CapacityChange, InventoryChange, ScheduleChange {
        String expectedVersion();
    }
    private record AvailabilityChange(String expectedVersion, String sku, boolean newValue) implements Change {}
    private record CapacityChange(String expectedVersion, String slotId, int capacity) implements Change {}
    private record InventoryChange(String expectedVersion, String sku, int onHand, Long stockRevision) implements Change {}
    private record ScheduleChange(String expectedVersion, PickupSchedule schedule) implements Change {}
    private record PickupSchedule(UUID id, LocalDate date, LocalTime start, LocalTime end, int capacity) {}

    OperatorCatalogAvailability(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = new TransactionTemplate(Objects.requireNonNull(transactions.getTransactionManager()), transactions);
        this.transactions.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.patchReader = mapper.readerFor(JsonNode.class)
            .with(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
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
        if (requested instanceof ScheduleChange shift && publishedSchedule(manager.storeId(), shift.schedule())) {
            return snapshot(manager.storeId());
        }
        if (!current.version().equals(requested.expectedVersion())) {
            throw OperatorFailure.conflict("catalog_version_conflict");
        }

        switch (requested) {
            case AvailabilityChange availability -> applyAvailabilityLocked(manager, current, availability);
            case CapacityChange capacity -> applyCapacityLocked(manager, current, capacity);
            case InventoryChange inventory -> applyInventoryLocked(manager, current, inventory);
            case ScheduleChange shift -> applyScheduleLocked(manager, current, shift.schedule());
        }
        return snapshot(manager.storeId());
    }

    private void applyAvailabilityLocked(Principal manager, CatalogState current, AvailabilityChange requested) {
        boolean storeChange = requested.sku() == null;
        boolean previous = storeChange ? current.open() : productAvailable(manager.storeId(), requested.sku());
        if (previous == requested.newValue()) return;

        if (!storeChange) {
            jdbc.sql("""
                UPDATE menu_products SET product = jsonb_set(product, '{available}', to_jsonb(CAST(? AS boolean)))
                WHERE store_id = ? AND sku = ?
                """).params(requested.newValue(), manager.storeId(), requested.sku()).update();
        }

        String revision = publish(manager.storeId(), storeChange ? requested.newValue() : current.open());
        jdbc.sql("""
            INSERT INTO operator_availability_events
                (store_id, operator_id, operator_username, action, sku, previous_value, new_value, previous_version, new_version)
            SELECT ?, a.id, a.username, ?, ?, ?, ?, ?, ? FROM operator_accounts a WHERE a.id = ?
            """).params(manager.storeId(), storeChange ? "store_open" : "product_available",
                requested.sku(), previous, requested.newValue(), current.version(), revision, manager.id()).update();
    }

    private void applyCapacityLocked(Principal manager, CatalogState current, CapacityChange requested) {
        String store = manager.storeId();
        String slot = requested.slotId();
        LockedSlot saved = jdbc.sql("SELECT starts_at, capacity FROM pickup_slots WHERE store_id = ? AND id = ? FOR UPDATE")
            .params(store, slot).query((rs, row) -> new LockedSlot(rs.getObject("starts_at", OffsetDateTime.class),
                rs.getInt("capacity"))).optional().orElseThrow(OperatorFailure::notFound);
        // Settlement can commit while this transaction waits for the slot. Count from a fresh snapshot after the lock.
        OffsetDateTime now = jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single();
        if (!saved.startsAt().isAfter(now)) throw OperatorFailure.conflict("slot_update_closed");
        if (saved.capacity() == requested.capacity()) return;
        long reserved = jdbc.sql("""
            SELECT count(*) FROM orders WHERE store_id = ? AND slot_id = ?
                AND pickup_reservation_occupies_slot(status, reservation_expires_at, ?)
            """).params(store, slot, now).query(Long.class).single();
        if (requested.capacity() < reserved) throw OperatorFailure.conflict("slot_capacity_below_reserved");

        jdbc.sql("UPDATE pickup_slots SET capacity = ? WHERE store_id = ? AND id = ?")
            .params(requested.capacity(), store, slot).update();
        String revision = publish(store, current.open());
        jdbc.sql("""
            INSERT INTO operator_availability_events (store_id, operator_id, operator_username, action,
                slot_id, previous_capacity, new_capacity, previous_version, new_version)
            SELECT ?, a.id, a.username, 'slot_capacity', ?, ?, ?, ?, ? FROM operator_accounts a WHERE a.id = ?
            """).params(store, slot, saved.capacity(), requested.capacity(), current.version(), revision, manager.id()).update();
    }

    private boolean publishedSchedule(String store, PickupSchedule requested) {
        var saved = jdbc.sql("""
            SELECT schedule_date, start_time, end_time, capacity
            FROM pickup_schedule_publications WHERE store_id = ? AND id = ?
            """).params(store, requested.id()).query((row, number) -> new PickupSchedule(requested.id(),
                row.getObject("schedule_date", LocalDate.class), row.getObject("start_time", LocalTime.class),
                row.getObject("end_time", LocalTime.class), row.getInt("capacity"))).optional();
        if (saved.isEmpty()) return false;
        if (!saved.orElseThrow().equals(requested)) throw OperatorFailure.conflict("pickup_schedule_conflict");
        return true;
    }

    private void applyInventoryLocked(Principal manager, CatalogState current, InventoryChange requested) {
        String store = manager.storeId();
        String sku = requested.sku();
        productAvailable(store, sku);
        var saved = jdbc.sql("""
            SELECT on_hand, revision FROM menu_product_inventory WHERE store_id = ? AND sku = ?
            """).params(store, sku).query((row, number) -> new Inventory(row.getInt("on_hand"), 0,
                row.getLong("revision"))).optional().orElse(null);
        if (!Objects.equals(requested.stockRevision(), saved == null ? null : saved.revision())) {
            throw OperatorFailure.conflict("stock_revision_conflict");
        }
        if (saved != null && saved.onHand() == requested.onHand()) return;
        long reserved = jdbc.sql("SELECT catalog_reserved_product_units(?, ?, clock_timestamp())")
            .params(store, sku).query(Long.class).single();
        if (requested.onHand() < reserved) throw OperatorFailure.conflict("stock_below_reserved");

        long inventoryRevision = jdbc.sql("""
            INSERT INTO menu_product_inventory (store_id, sku, on_hand) VALUES (?, ?, ?)
            ON CONFLICT (store_id, sku) DO UPDATE SET on_hand = EXCLUDED.on_hand,
                revision = menu_product_inventory.revision + 1
            RETURNING revision
            """).params(store, sku, requested.onHand()).query(Long.class).single();
        publish(store, current.open());
        jdbc.sql("""
            INSERT INTO operator_inventory_events
                (store_id, sku, operator_id, previous_on_hand, new_on_hand, inventory_revision)
            VALUES (?, ?, ?, ?, ?, ?)
            """).params(store, sku, manager.id(), saved == null ? null : saved.onHand(),
                requested.onHand(), inventoryRevision).update();
    }

    private void applyScheduleLocked(Principal manager, CatalogState current, PickupSchedule shift) {
        String store = manager.storeId();
        OffsetDateTime start = shift.date().atTime(shift.start()).atZone(KIGALI).toOffsetDateTime();
        OffsetDateTime end = shift.date().atTime(shift.end()).atZone(KIGALI).toOffsetDateTime();
        OffsetDateTime now = jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single();
        if (!start.isAfter(now)) throw OperatorFailure.conflict("pickup_schedule_started");
        boolean overlaps = jdbc.sql("""
            SELECT EXISTS (
                SELECT 1 FROM pickup_slots WHERE store_id = ? AND starts_at < ? AND ends_at > ?
            )
            """).params(store, end, start).query(Boolean.class).single();
        if (overlaps) throw OperatorFailure.conflict("pickup_schedule_overlap");

        String step = SLOT_MINUTES + " minutes";
        int inserted = jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            SELECT ?, 'shift-' || CAST(? AS text) || '-' || window_number,
                window_start, window_start + CAST(? AS interval), ?
            FROM generate_series(CAST(? AS timestamptz),
                CAST(? AS timestamptz) - CAST(? AS interval), CAST(? AS interval))
                WITH ORDINALITY AS windows(window_start, window_number)
            ON CONFLICT (store_id, id) DO NOTHING
            """).params(store, shift.id(), step, shift.capacity(), start, end, step, step).update();
        if (inserted != Duration.between(start, end).toMinutes() / SLOT_MINUTES) {
            // A preexisting catalog ID must not leave a partially published shift.
            throw OperatorFailure.conflict("pickup_schedule_conflict");
        }
        String revision = publish(store, current.open());
        jdbc.sql("""
            INSERT INTO pickup_schedule_publications (store_id, id, schedule_date, start_time, end_time, capacity,
                operator_id, operator_username, previous_version, new_version)
            SELECT ?, ?, ?, ?, ?, ?, a.id, a.username, ?, ? FROM operator_accounts a WHERE a.id = ?
            """).params(store, shift.id(), shift.date(), shift.start(), shift.end(), shift.capacity(),
                current.version(), revision, manager.id()).update();
    }

    private String publish(String store, boolean open) {
        String revision = "runtime-" + UUID.randomUUID();
        jdbc.sql("UPDATE stores SET open = ?, version = ?, updated_at = clock_timestamp() WHERE id = ?")
            .params(open, revision, store).update();
        return revision;
    }

    private boolean productAvailable(String store, String sku) {
        return jdbc.sql("SELECT (product->>'available')::boolean FROM menu_products WHERE store_id = ? AND sku = ?")
            .params(store, sku).query(Boolean.class).optional().orElseThrow(OperatorFailure::notFound);
    }

    private Snapshot snapshot(String store) {
        List<SnapshotRow> rows = jdbc.sql("""
            SELECT s.version, s.open, p.sku, p.product#>>'{name,en}' AS name_en, p.product#>>'{name,rw}' AS name_rw,
                (p.product->>'available')::boolean AS product_available, i.on_hand, i.revision,
                CASE WHEN i.sku IS NOT NULL THEN
                    catalog_reserved_product_units(i.store_id, i.sku, statement_timestamp()) END AS reserved_units
            FROM stores s LEFT JOIN menu_products p ON p.store_id = s.id
            LEFT JOIN menu_product_inventory i ON i.store_id = p.store_id AND i.sku = p.sku
            WHERE s.id = ? ORDER BY p.position, p.sku
            """).param(store).query(OperatorCatalogAvailability::snapshotRow).list();
        if (rows.isEmpty()) throw OperatorFailure.notFound();
        SnapshotRow state = rows.getFirst();
        return new Snapshot(state.version(), state.open(), rows.stream().map(SnapshotRow::product)
            .filter(Objects::nonNull).toList(), upcomingSlots(store));
    }

    private List<SlotAvailability> upcomingSlots(String store) {
        return jdbc.sql("""
            WITH checked_at AS MATERIALIZED (SELECT clock_timestamp() AS value),
            upcoming AS (
                SELECT p.store_id, p.id, p.starts_at, p.ends_at, p.capacity, checked_at.value
                FROM pickup_slots p CROSS JOIN checked_at
                WHERE p.store_id = ? AND p.starts_at > checked_at.value
                ORDER BY p.starts_at, p.id LIMIT 36
            )
            SELECT p.id, p.starts_at, p.ends_at, p.capacity, count(o.id) AS reserved
            FROM upcoming p
            LEFT JOIN orders o ON o.store_id = p.store_id AND o.slot_id = p.id
                AND pickup_reservation_occupies_slot(o.status, o.reservation_expires_at, p.value)
            GROUP BY p.id, p.starts_at, p.ends_at, p.capacity
            ORDER BY p.starts_at, p.id
            """).param(store).query((rs, row) -> new SlotAvailability(rs.getString("id"),
                rs.getObject("starts_at", OffsetDateTime.class).toInstant(), rs.getObject("ends_at", OffsetDateTime.class).toInstant(),
                rs.getInt("capacity"), rs.getInt("reserved"))).list();
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
            Integer onHand = rs.getObject("on_hand", Integer.class);
            Inventory stock = onHand == null ? null : new Inventory(onHand, rs.getLong("reserved_units"),
                rs.getLong("revision"));
            product = new ProductAvailability(sku, new Localized(en, rw), available, stock);
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
        if (body.size() == 2 && open.isBoolean()) return new AvailabilityChange(version, null, open.booleanValue());

        JsonNode available = body.path("available");
        if (body.size() == 3 && available.isBoolean()) {
            return new AvailabilityChange(version, identifier(body.path("sku")), available.booleanValue());
        }
        JsonNode capacity = body.path("capacity");
        if (body.size() == 3 && capacity.isIntegralNumber() && capacity.canConvertToInt() && capacity.intValue() >= 0) {
            return new CapacityChange(version, identifier(body.path("slotId")), capacity.intValue());
        }
        JsonNode onHand = body.path("stockOnHand");
        JsonNode stockRevision = body.path("stockRevision");
        if (body.size() == 4 && onHand.isIntegralNumber() && onHand.canConvertToInt() && onHand.intValue() >= 0
            && (stockRevision.isNull() || stockRevision.isIntegralNumber() && stockRevision.canConvertToLong()
            && stockRevision.longValue() > 0)) {
            return new InventoryChange(version, identifier(body.path("sku")), onHand.intValue(),
                stockRevision.isNull() ? null : stockRevision.longValue());
        }
        JsonNode schedule = body.path("pickupSchedule");
        if (body.size() == 2 && schedule.isObject()) return new ScheduleChange(version, parseSchedule(schedule));
        throw OperatorFailure.invalid();
    }

    private static PickupSchedule parseSchedule(JsonNode schedule) {
        JsonNode capacity = schedule.path("capacity");
        if (schedule.size() != 5 || !capacity.isIntegralNumber() || !capacity.canConvertToInt()
            || capacity.intValue() < 1) throw OperatorFailure.invalid();
        String id = identifier(schedule.path("id"));
        String dateValue = identifier(schedule.path("date"));
        String startValue = identifier(schedule.path("start"));
        String endValue = identifier(schedule.path("end"));
        if (!SCHEDULE_DATE.matcher(dateValue).matches() || !SCHEDULE_TIME.matcher(startValue).matches()
            || !SCHEDULE_TIME.matcher(endValue).matches()) throw OperatorFailure.invalid();
        try {
            UUID key = UUID.fromString(id);
            LocalDate date = LocalDate.parse(dateValue);
            LocalTime start = LocalTime.parse(startValue);
            LocalTime end = LocalTime.parse(endValue);
            if (!key.toString().equalsIgnoreCase(id) || date.getYear() < 1 || !end.isAfter(start)
                || start.getMinute() % SLOT_MINUTES != 0 || end.getMinute() % SLOT_MINUTES != 0) {
                throw OperatorFailure.invalid();
            }
            return new PickupSchedule(key, date, start, end, capacity.intValue());
        } catch (IllegalArgumentException | DateTimeException ignored) {
            throw OperatorFailure.invalid();
        }
    }

    private static String identifier(JsonNode field) {
        if (!field.isString() || !CATALOG_ID.matcher(field.stringValue()).matches()) throw OperatorFailure.invalid();
        return field.stringValue();
    }
}
