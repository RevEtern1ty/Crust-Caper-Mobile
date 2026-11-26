package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorSessions.Principal;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;

@Service
final class OperatorExternalOrders {
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final Pattern CHANNEL_ID = Pattern.compile("[a-z0-9][a-z0-9._-]{0,31}");
    private static final Pattern REFERENCE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._/-]{0,63}");
    private static final Pattern UTC_INSTANT = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z");
    private static final String ACTIVE = "('accepted', 'preparing', 'ready')";
    private static final String SELECT = """
            SELECT o.id, o.channel, o.channel_label, o.external_reference, o.scheduled_at,
                o.accepted_at, o.status, o.lines, o.status = 'collected' AND EXISTS (
                    SELECT FROM operator_external_order_events e
                    WHERE e.order_id = o.id AND e.requested_status = 'collected' AND e.operator_id = ?
                ) AS confirmed
            FROM operator_external_orders o WHERE o.store_id = ?
            """;

    record Channel(String id, String label) { }
    record Channels(List<Channel> channels) { }
    record Line(String name, int quantity, List<String> modifiers) { }
    record Order(UUID id, String channel, String channelLabel, String externalReference, Instant scheduledAt,
                 Instant acceptedAt, String status, List<Line> lines, boolean confirmedByCurrentOperator) { }
    record Registration(Order order, boolean created) { }
    private record NewOrder(String channel, String reference, Instant scheduled, List<Line> lines) { }
    private record Change(Transition transition, String reference) { }

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final ObjectMapper mapper;
    private final ObjectReader reader;
    private final ObjectReader lineReader;

    OperatorExternalOrders(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
        this.mapper = mapper;
        reader = mapper.readerFor(JsonNode.class)
            .with(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
        lineReader = mapper.readerForListOf(Line.class);
    }

    Channels channels(String authorization) {
        Principal actor = registrar(authorization, false);
        return new Channels(jdbc.sql("""
                SELECT id, label FROM operator_external_order_channels
                WHERE store_id = ? AND enabled ORDER BY label, id
                """).param(actor.storeId())
            .query((row, index) -> new Channel(row.getString("id"), row.getString("label"))).list());
    }

    List<Order> active(Principal actor) {
        // Active orders cannot have a collection event, so the public queue never reports pickup confirmation.
        return query(actor, " AND o.status IN " + ACTIVE + " ORDER BY o.scheduled_at, o.id").list();
    }

    Order get(String authorization, String id) {
        return findById(sessions.requirePrincipal(authorization, false), orderId(id), false);
    }

    Registration register(String authorization, HttpServletRequest request) {
        registrar(authorization, false);
        NewOrder input = newOrder(body(request));
        return Objects.requireNonNull(transactions.execute(tx -> registerLocked(registrar(authorization, true), input)));
    }

    Order change(String authorization, String id, HttpServletRequest request) {
        sessions.requirePrincipal(authorization, false);
        UUID orderId = orderId(id);
        Change input = change(body(request));
        return Objects.requireNonNull(transactions.execute(tx -> changeLocked(sessions.requirePrincipal(authorization, true), orderId, input)));
    }

    private Registration registerLocked(Principal actor, NewOrder input) {
        Optional<Order> existing = findByReference(actor, input);
        if (existing.isPresent()) return replay(existing.get(), input);

        Optional<String> label = jdbc.sql("""
                SELECT label FROM operator_external_order_channels
                WHERE store_id = ? AND id = ? AND enabled FOR SHARE
                """).params(actor.storeId(), input.channel()).query(String.class).optional();
        if (label.isEmpty()) {
            // A competing registration may have committed just before the channel was disabled.
            return findByReference(actor, input).map(order -> replay(order, input))
                .orElseThrow(() -> OperatorFailure.conflict("external_channel_unavailable"));
        }

        UUID id = UUID.randomUUID();
        int inserted = jdbc.sql("""
                INSERT INTO operator_external_orders
                    (id, store_id, channel, channel_label, external_reference, scheduled_at, lines, registered_by)
                VALUES (?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?)
                ON CONFLICT (store_id, channel, external_reference) DO NOTHING
                """).params(id, actor.storeId(), input.channel(), label.get(), input.reference(),
                     input.scheduled().atOffset(ZoneOffset.UTC), mapper.writeValueAsString(input.lines()), actor.id()).update();
        if (inserted == 1) return new Registration(findById(actor, id, false), true);

        // READ COMMITTED starts a fresh snapshot here and sees the committed winning row.
        Order winning = findByReference(actor, input).orElseThrow(OperatorFailure::notFound);
        return replay(winning, input);
    }

    private static Registration replay(Order existing, NewOrder input) {
        if (!existing.scheduledAt().equals(input.scheduled()) || !existing.lines().equals(input.lines())) {
            throw OperatorFailure.conflict("external_reference_conflict");
        }
        return new Registration(existing, false);
    }

    private Order changeLocked(Principal actor, UUID id, Change input) {
        Transition transition = input.transition();
        if (!actor.role().equals(transition.role) && !actor.role().equals("manager")) throw OperatorFailure.forbidden();
        Order current = findById(actor, id, true);
        if (transition == Transition.COLLECTED && !current.externalReference().equals(input.reference())) {
            throw OperatorFailure.conflict("external_reference_mismatch");
        }
        if (!transition.allows(current.status())) {
            boolean alreadyApplied = jdbc.sql("""
                    SELECT EXISTS (SELECT FROM operator_external_order_events
                        WHERE order_id = ? AND requested_status = ? AND operator_id = ?)
                    """).params(id, transition.status, actor.id()).query(Boolean.class).single();
            // A row lock may have waited for the writer after the first statement took its snapshot.
            // Read again so its now-committed confirmation event is also visible in a successful replay.
            if (alreadyApplied) return findById(actor, id, false);
            throw OperatorFailure.conflict("invalid_transition");
        }

        jdbc.sql("UPDATE operator_external_orders SET status = ? WHERE id = ? AND store_id = ?")
            .params(transition.status, id, actor.storeId()).update();
        jdbc.sql("""
                INSERT INTO operator_external_order_events
                    (order_id, operator_id, operator_role, previous_status, requested_status)
                VALUES (?, ?, ?, ?, ?)
                """).params(id, actor.id(), actor.role(), current.status(), transition.status).update();
        return new Order(current.id(), current.channel(), current.channelLabel(), current.externalReference(),
            current.scheduledAt(), current.acceptedAt(), transition.status, current.lines(), transition == Transition.COLLECTED);
    }

    private Principal registrar(String authorization, boolean lock) {
        Principal actor = sessions.requirePrincipal(authorization, lock);
        if (!actor.role().equals("pickup") && !actor.role().equals("manager")) throw OperatorFailure.forbidden();
        return actor;
    }

    private Order findById(Principal actor, UUID id, boolean lock) {
        return query(actor, " AND o.id = ?" + (lock ? " FOR UPDATE OF o" : ""), id)
            .optional().orElseThrow(OperatorFailure::notFound);
    }

    private Optional<Order> findByReference(Principal actor, NewOrder input) {
        return query(actor, " AND o.channel = ? AND o.external_reference = ?", input.channel(), input.reference()).optional();
    }

    private JdbcClient.MappedQuerySpec<Order> query(Principal actor, String criteria, Object... parameters) {
        return jdbc.sql(SELECT + criteria).params(actor.id(), actor.storeId()).params(parameters).query(this::row);
    }

    private Order row(ResultSet row, int index) throws SQLException {
        List<Line> lines = lineReader.readValue(row.getString("lines"));
        return new Order(row.getObject("id", UUID.class), row.getString("channel"), row.getString("channel_label"),
            row.getString("external_reference"), row.getObject("scheduled_at", OffsetDateTime.class).toInstant(),
            row.getObject("accepted_at", OffsetDateTime.class).toInstant(), row.getString("status"), lines, row.getBoolean("confirmed"));
    }

    private JsonNode body(HttpServletRequest request) {
        if (request.getContentLengthLong() > MAX_BODY_BYTES) throw OperatorFailure.invalid();
        try {
            byte[] bytes = request.getInputStream().readNBytes(MAX_BODY_BYTES + 1);
            if (bytes.length == 0 || bytes.length > MAX_BODY_BYTES) throw OperatorFailure.invalid();
            JsonNode body = reader.readTree(bytes);
            if (body == null || !body.isObject()) throw OperatorFailure.invalid();
            return body;
        } catch (IOException | JacksonException invalid) {
            throw OperatorFailure.invalid();
        }
    }

    private static NewOrder newOrder(JsonNode body) {
        if (body.size() != 4) throw OperatorFailure.invalid();
        String channel = identifier(body.path("channel"), CHANNEL_ID);
        String reference = identifier(body.path("externalReference"), REFERENCE);
        String scheduled = text(body.path("scheduledAt"), 27);
        if (!UTC_INSTANT.matcher(scheduled).matches() || scheduled.startsWith("0000")) throw OperatorFailure.invalid();
        Instant instant;
        try {
            instant = OffsetDateTime.parse(scheduled).toInstant();
        } catch (DateTimeParseException invalid) {
            throw OperatorFailure.invalid();
        }

        JsonNode lines = body.path("lines");
        if (!lines.isArray() || lines.size() < 1 || lines.size() > 30) throw OperatorFailure.invalid();
        List<Line> items = new ArrayList<>(lines.size());
        for (JsonNode line : lines) items.add(line(line));
        return new NewOrder(channel, reference, instant, List.copyOf(items));
    }

    private static Line line(JsonNode line) {
        JsonNode modifiers = line.path("modifiers");
        if (!line.isObject() || line.size() != (modifiers.isMissingNode() ? 2 : 3)) throw OperatorFailure.invalid();
        String name = text(line.path("name"), 120);
        JsonNode quantity = line.path("quantity");
        if (!quantity.isIntegralNumber() || !quantity.canConvertToInt() || quantity.intValue() < 1 || quantity.intValue() > 99) {
            throw OperatorFailure.invalid();
        }
        if (modifiers.isMissingNode()) return new Line(name, quantity.intValue(), List.of());
        if (!modifiers.isArray() || modifiers.size() > 12) throw OperatorFailure.invalid();
        List<String> values = new ArrayList<>(modifiers.size());
        for (JsonNode modifier : modifiers) values.add(text(modifier, 120));
        return new Line(name, quantity.intValue(), List.copyOf(values));
    }

    private static Change change(JsonNode body) {
        Transition transition = switch (text(body.path("status"), 10)) {
            case "preparing" -> Transition.PREPARING;
            case "ready" -> Transition.READY;
            case "collected" -> Transition.COLLECTED;
            case "cancelled" -> Transition.CANCELLED;
            default -> throw OperatorFailure.invalid();
        };
        if (transition == Transition.COLLECTED && body.size() == 2) {
            return new Change(transition, identifier(body.path("externalReference"), REFERENCE));
        }
        if (transition != Transition.COLLECTED && body.size() == 1) return new Change(transition, null);
        throw OperatorFailure.invalid();
    }

    private static String identifier(JsonNode value, Pattern pattern) {
        String identifier = text(value, 64);
        if (!pattern.matcher(identifier).matches()) throw OperatorFailure.invalid();
        return identifier;
    }

    private static String text(JsonNode value, int maximum) {
        String raw = value.stringValue();
        if (raw == null || raw.codePoints().anyMatch(Character::isISOControl)) throw OperatorFailure.invalid();
        String text = raw.strip();
        if (text.isEmpty() || text.codePointCount(0, text.length()) > maximum || text.codePoints().anyMatch(c ->
                c >= Character.MIN_SURROGATE && c <= Character.MAX_SURROGATE)) throw OperatorFailure.invalid();
        return text;
    }

    private static UUID orderId(String raw) {
        if (raw.length() != 36) throw OperatorFailure.invalid();
        try {
            UUID id = UUID.fromString(raw);
            if (id.toString().equalsIgnoreCase(raw)) return id;
        } catch (IllegalArgumentException ignored) {
            // Fall through to the common input error.
        }
        throw OperatorFailure.invalid();
    }

    private enum Transition {
        PREPARING("preparing", "kitchen", List.of("accepted")),
        READY("ready", "kitchen", List.of("preparing")),
        COLLECTED("collected", "pickup", List.of("ready")),
        CANCELLED("cancelled", "manager", List.of("accepted", "preparing", "ready"));

        private final String status;
        private final String role;
        private final List<String> from;

        Transition(String status, String role, List<String> from) {
            this.status = status;
            this.role = role;
            this.from = from;
        }

        boolean allows(String previous) { return from.contains(previous); }
    }
}
