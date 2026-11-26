package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.*;
import static com.crustcaper.api.Catalog.dbTime;
import static com.crustcaper.api.Catalog.readTime;

import com.crustcaper.api.payment.PaymentGateway;
import com.crustcaper.api.payment.PaymentGateway.CheckoutChannel;
import com.crustcaper.api.payment.PaymentGateway.PaymentRequest;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import com.crustcaper.api.payment.PaymentGatewayException;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonUnwrapped;
import tools.jackson.core.type.TypeReference;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;
import java.security.SecureRandom;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class OrderService {
    public static final int AUTOMATIC_RECONCILIATION_WINDOW_HOURS = 48;
    public static final int OVERDUE_PAYMENT_CHECK_COOLDOWN_SECONDS = 60;
    public static final String PAYMENT_MISMATCH = "payment_mismatch";

    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern CATALOG_ID = Pattern.compile("[A-Za-z0-9._:-]{1,100}");
    private static final Pattern PHONE = Pattern.compile("\\+[1-9][0-9]{7,14}");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final TypeReference<List<CartLine>> CART_LINES = new TypeReference<>() {};
    private static final String ORDER = "SELECT * FROM orders WHERE id = ?";
    private static final String CHECKOUT_GUEST = """
        AND (orders.guest_session_id = ?
            OR COALESCE(orders.mobile_checkout_guest_session_id, orders.web_checkout_guest_session_id) = ?)
        """;
    private static final String VISIBLE_TO_GUEST = """
        AND (orders.guest_session_id = ? OR EXISTS (
            SELECT FROM order_read_grants g WHERE g.guest_session_id = ? AND g.order_id = orders.id
        ))
        """;
    private static final String LATEST_ATTEMPT = """
        SELECT * FROM payment_attempts WHERE order_id = ? ORDER BY sequence DESC LIMIT 1
        """;
    private static final String PAYMENT_ATTEMPT_VIEW_COLUMNS = """
        attempt.id AS attempt_id, attempt.status AS attempt_status,
        CASE WHEN orders.status = 'awaiting_payment' AND orders.payment_status = 'processing'
            AND orders.reservation_expires_at > statement_timestamp() AND attempt.status = 'processing'
            THEN attempt.checkout_url END AS checkout_url
        """;
    private static final String ORDER_SNAPSHOT = """
        SELECT orders.*, statement_timestamp() AS checked_at,
        """ + PAYMENT_ATTEMPT_VIEW_COLUMNS + """
        FROM orders
        LEFT JOIN LATERAL (
            SELECT id, status, checkout_url FROM payment_attempts
            WHERE order_id = orders.id ORDER BY sequence DESC LIMIT 1
        ) attempt ON true
        """;
    private static final long MAX_PRICE = 1_000_000_000L;

    private final JdbcClient jdbc;
    private final Catalog catalog;
    private final CommerceJson json;
    private final PaymentGateway gateway;
    private final TransactionTemplate transactions;
    private final boolean localPayments;

    private record StoredQuote(
        UUID id, String storeId, String slotId, Instant startsAt, Instant endsAt, List<CartLine> lines,
        long total, long tax, Instant expiresAt
    ) {}

    private record StoredOrder(
        UUID id, UUID quoteId, UUID owner, String storeId, String slotId, String phone, String email,
        List<CartLine> lines, long total, long tax, String status, String paymentStatus, String pickupCode,
        String receiptStatus, String receiptUrl, Instant createdAt, Instant reservationExpiresAt,
        Instant startsAt, Instant endsAt, CheckoutChannel checkoutChannel, UUID recoveredGuest
    ) {
        boolean canCheckout(UUID guest) {
            return owner.equals(guest) || guest.equals(recoveredGuest);
        }
    }

    private record OrderSnapshot(StoredOrder order, PaymentAttempt attempt, Instant checkedAt) {}
    record ReadOrder(@JsonUnwrapped Order order,
                     @JsonInclude(JsonInclude.Include.NON_NULL) Boolean recoveryReadOnly) {}

    private record Attempt(UUID id, UUID orderId, String status, String providerTransactionId) {}

    private record PaymentStart(Attempt attempt, StoredOrder order, boolean openGateway) {}
    record CheckoutLookup(UUID orderId, Instant retryAt) {}

    OrderService(JdbcClient jdbc, Catalog catalog, CommerceJson json, PaymentGateway gateway,
                 TransactionTemplate transactions, @Value("${crustcaper.payment.provider}") String provider) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.json = json;
        this.gateway = gateway;
        this.transactions = new TransactionTemplate(Objects.requireNonNull(transactions.getTransactionManager()), transactions);
        this.transactions.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.localPayments = provider.equals("local");
    }

    @Transactional
    public Quote createQuote(UUID guest, QuoteInput input) {
        return createQuote(guest, input, false);
    }

    @Transactional
    public Quote createWebQuote(UUID guest, QuoteInput input) {
        return createQuote(guest, input, true);
    }

    private Quote createQuote(UUID guest, QuoteInput input, boolean webCheckout) {
        validateQuote(input);
        Instant now = databaseNow();
        Catalog.QuoteCatalog quotedCatalog = catalog.quoteCatalog(input.storeId(), input.lines());
        Catalog.StoreData store = quotedCatalog.store();
        Catalog.SlotData slot = catalog.slot(input.storeId(), input.slotId(), false);
        if (!catalog.available(store.store(), slot, now)) throw ApiFailure.conflict("slot_unavailable");
        Reorder current = Catalog.reconcile(input.lines(), quotedCatalog.products(), store.version());
        long total = total(current.lines());
        requireSupportedTotal(total);
        long divisor = 10_000L + store.taxBasisPoints();
        long tax = (total * store.taxBasisPoints() + divisor / 2) / divisor;
        Instant expiresAt = earlier(now.plus(5, ChronoUnit.MINUTES), slot.startsAt());
        UUID id = UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at,
                lines, total, tax, expires_at, web_checkout)
            VALUES (?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?, ?, ?)
            """)
            .params(id, guest, input.storeId(), slot.id(), dbTime(slot.startsAt()), dbTime(slot.endsAt()),
                json.write(current.lines()), total, tax, dbTime(expiresAt), webCheckout)
            .update();
        return new Quote(id, input.storeId(), slot.id(), current.lines(), total - tax, tax, total, CURRENCY,
            expiresAt, current.changes(), slot.startsAt(), slot.endsAt());
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Order createOrder(UUID guest, String key, OrderInput input) {
        return createOrder(guest, key, input, CheckoutChannel.MOBILE);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Order createWebOrder(UUID guest, String key, OrderInput input) {
        return createOrder(guest, key, input, CheckoutChannel.WEB);
    }

    private Order createOrder(UUID guest, String key, OrderInput input, CheckoutChannel channel) {
        validateKey(key);
        if (input == null) throw ApiFailure.invalid();
        UUID quoteId = ApiFailure.uuid(input.quoteId(), ApiFailure.invalid());
        String phone = input.phone() == null ? "" : input.phone().replaceAll("\\s+", "");
        String email = input.email() == null || input.email().isBlank() ? null : input.email().strip();
        if (!PHONE.matcher(phone).matches()
            || (email == null && !localPayments)
            || (email != null && !PaymentGateway.supportsCustomerEmail(email))) {
            throw ApiFailure.invalid();
        }

        // Check expiry after locking the guest that owns the order's idempotency key.
        jdbc.sql("""
            WITH locked_guest AS MATERIALIZED (
                SELECT id, expires_at FROM guest_sessions WHERE id = ? FOR UPDATE
            )
            SELECT id FROM locked_guest WHERE expires_at > clock_timestamp()
            """)
            .param(guest).query(UUID.class).optional().orElseThrow(ApiFailure::unauthenticated);
        OrderSnapshot existing = recoverSnapshot(guest, key);
        if (existing != null) {
            StoredOrder order = existing.order();
            if (!order.quoteId().equals(quoteId) || !order.phone().equals(phone)
                || !Objects.equals(order.email(), email)) throw ApiFailure.conflict("conflict");
            return view(existing, true);
        }
        if (jdbc.sql("SELECT 1 FROM orders WHERE quote_id = ? AND guest_session_id = ?")
            .params(quoteId, guest).query(Integer.class).optional().isPresent()) throw ApiFailure.conflict("conflict");

        StoredQuote quote = jdbc.sql("SELECT * FROM quotes WHERE id = ? AND guest_session_id = ?")
            .params(quoteId, guest).query(this::quoteRow)
            .optional().orElseThrow(() -> ApiFailure.conflict("quote_expired"));
        requireSupportedTotal(quote.total());
        Catalog.StoreData store = catalog.store(quote.storeId(), true);
        Catalog.SlotData slot = catalog.slot(quote.storeId(), quote.slotId(), true);
        Instant now = databaseNow();
        if (!quote.expiresAt().isAfter(now)) throw ApiFailure.conflict("quote_expired");
        if (!slot.startsAt().equals(quote.startsAt()) || !slot.endsAt().equals(quote.endsAt())) {
            throw ApiFailure.conflict("quote_changed");
        }
        if (!catalog.available(store.store(), slot, now)) throw ApiFailure.conflict("slot_unavailable");
        Reorder current = Catalog.reconcile(quote.lines(), catalog.products(quote.storeId(), true), store.version());
        long divisor = 10_000L + store.taxBasisPoints();
        long tax = (quote.total() * store.taxBasisPoints() + divisor / 2) / divisor;
        if (quote.total() <= 0 || !current.changes().isEmpty() || tax != quote.tax()
            || !sameSoldItems(quote.lines(), current.lines())) {
            throw ApiFailure.conflict("quote_changed");
        }
        // PostgreSQL rechecks capacity while holding the slot row, before inserting the reservation.
        UUID id = UUID.randomUUID();
        Instant hold = earlier(now.plus(10, ChronoUnit.MINUTES), slot.startsAt());
        jdbc.sql("""
            INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone,
                email, lines, total, tax, status, payment_status, created_at, reservation_expires_at,
                pickup_starts_at, pickup_ends_at, checkout_channel)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?, 'awaiting_payment', 'unpaid', ?, ?, ?, ?, ?)
            """)
            .params(id, quote.id(), guest, key, quote.storeId(), slot.id(), phone, email,
                json.write(quote.lines()), quote.total(), quote.tax(), dbTime(now), dbTime(hold),
                dbTime(slot.startsAt()), dbTime(slot.endsAt()), channel.name().toLowerCase(Locale.ROOT))
            .update();
        return view(ownedSnapshot(guest, id), true);
    }

    private static boolean sameSoldItems(List<CartLine> quoted, List<CartLine> current) {
        if (quoted.size() != current.size()) return false;
        for (int line = 0; line < quoted.size(); line++) {
            SoldItem before = quoted.get(line).soldItem();
            SoldItem after = current.get(line).soldItem();
            // A previous release's quote cannot establish which recipe was offered.
            if (before == null || after == null || !before.name().equals(after.name())
                || !before.ingredients().equals(after.ingredients()) || !before.allergens().equals(after.allergens())
                || !new HashSet<>(before.modifiers()).equals(new HashSet<>(after.modifiers()))) return false;
        }
        return true;
    }

    public Order recover(UUID guest, String key) {
        validateKey(key);
        OrderSnapshot existing = recoverSnapshot(guest, key);
        if (existing == null) throw ApiFailure.notFound();
        return view(existing, true);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public CheckoutLookup lookupCheckout(String quote, String key, CheckoutChannel channel) {
        validateKey(key);
        UUID quoteId = ApiFailure.uuid(quote, ApiFailure.invalid());
        if (!quoteId.toString().equalsIgnoreCase(quote)) throw ApiFailure.invalid();
        // Order creation locks this same guest before checking quote expiry and inserting.
        jdbc.sql("""
            SELECT g.id FROM quotes q JOIN guest_sessions g ON g.id = q.guest_session_id
            WHERE q.id = ? AND q.web_checkout = ?
            FOR UPDATE OF g
            """).params(quoteId, channel == CheckoutChannel.WEB).query(UUID.class).optional().orElseThrow(ApiFailure::notFound);
        // Use a new statement to see a commit made while waiting for the guest's lock.
        return jdbc.sql("""
            SELECT o.id, o.request_key, o.checkout_channel, q.expires_at, q.expires_at > clock_timestamp() AS active
            FROM quotes q LEFT JOIN orders o ON o.quote_id = q.id WHERE q.id = ?
            """).param(quoteId).query((rs, row) -> {
                UUID orderId = rs.getObject("id", UUID.class);
                if (orderId != null && (!channel.name().equalsIgnoreCase(rs.getString("checkout_channel"))
                    || !key.equals(rs.getString("request_key")))) throw ApiFailure.notFound();
                Instant retryAt = orderId == null && rs.getBoolean("active") ? readTime(rs, "expires_at") : null;
                return new CheckoutLookup(orderId, retryAt);
            }).optional().orElseThrow(ApiFailure::notFound);
    }

    public Order getOrder(UUID guest, UUID id) {
        return readOrder(guest, id).order();
    }

    WebOrder getWebOrder(UUID guest, UUID id) {
        ReadOrder result = readOrder(guest, id);
        return WebOrder.from(result.order(), Boolean.TRUE.equals(result.recoveryReadOnly()));
    }

    ReadOrder getMobileOrder(UUID guest, UUID id) {
        ReadOrder result = readOrder(guest, id);
        Order order = result.order();
        // A settled order can close the saved payment journal and can be used to reorder.
        return order.status().equals("awaiting_payment") || order.paymentStatus().equals("processing")
            ? result : new ReadOrder(order, null);
    }

    private ReadOrder readOrder(UUID guest, UUID id) {
        OrderSnapshot snapshot = jdbc.sql(ORDER_SNAPSHOT + "WHERE orders.id = ? " + VISIBLE_TO_GUEST)
            .params(id, guest, guest).query(this::snapshotRow).optional().orElseThrow(ApiFailure::notFound);
        if (!snapshot.order().canCheckout(guest)) return new ReadOrder(view(snapshot, false), true);
        PaymentAttempt attempt = snapshot.attempt();
        if (attempt != null && attempt.status().equals("processing") && !localPayments
            && claimVerification(attempt.id())) {
            try {
                gateway.verifyByReference(attempt.id().toString()).ifPresent(this::settlePayment);
            } catch (PaymentGatewayException ignored) {
                // Keep the last confirmed state during a temporary PSP outage.
            } catch (ApiFailure error) {
                if (!PAYMENT_MISMATCH.equals(error.code())) throw error;
                // Reject unrelated money without hiding the order or changing its payment state.
            }
            snapshot = ownedSnapshot(guest, id);
        }
        return new ReadOrder(view(snapshot, true), null);
    }

    public Reorder reorder(UUID guest, UUID id) {
        StoredOrder order = visible(guest, id);
        return Catalog.reconcile(order.lines(), catalog.products(order.storeId(), false));
    }

    byte[] receiptDocument(UUID guest, UUID id) {
        return jdbc.sql("""
            SELECT f.document FROM fiscal_receipts f JOIN orders ON orders.id = f.order_id
            WHERE orders.id = ? AND orders.receipt_status = 'issued'
            """ + VISIBLE_TO_GUEST)
            .params(id, guest, guest).query((rs, row) -> rs.getBytes("document"))
            .optional().orElseThrow(ApiFailure::notFound);
    }

    record PickupAlertOrder(String status, String paymentStatus, boolean pickupOpen) {
        boolean allowsEnrollment() {
            return pickupOpen && paymentStatus.equals("paid") && (status.equals("accepted") || status.equals("preparing"));
        }
    }

    PickupAlertOrder pickupAlertOrder(UUID guest, UUID id, boolean lock) {
        // Evaluate the end of the pickup window after waiting for a concurrent kitchen or delivery lock.
        return jdbc.sql("""
            WITH visible_order AS MATERIALIZED (
                SELECT status, payment_status, pickup_ends_at FROM orders WHERE id = ?
            """ + VISIBLE_TO_GUEST + (lock ? " FOR UPDATE OF orders" : "") + """
            )
            SELECT status, payment_status, pickup_ends_at > clock_timestamp() AS pickup_open FROM visible_order
            """)
            .params(id, guest, guest)
            .query((rs, row) -> new PickupAlertOrder(rs.getString("status"), rs.getString("payment_status"),
                rs.getBoolean("pickup_open")))
            .optional().orElseThrow(ApiFailure::notFound);
    }

    public PaymentAttempt startPayment(UUID guest, UUID id, String key) {
        validateKey(key);
        PaymentStart start = Objects.requireNonNull(transactions.execute(tx -> preparePayment(guest, id, key)));
        Attempt attempt = start.attempt();
        if (!start.openGateway()) return paymentAttemptView(attempt.id());
        StoredOrder order = start.order();
        try {
            String checkoutUrl = gateway.open(new PaymentRequest(attempt.id().toString(), id.toString(),
                order.total(), CURRENCY, order.phone(), order.email(), order.reservationExpiresAt(),
                order.checkoutChannel())).checkoutUrl();
            jdbc.sql("UPDATE payment_attempts SET checkout_url = ? WHERE id = ? AND status = 'processing'")
                .params(checkoutUrl, attempt.id()).update();
            return paymentAttemptView(attempt.id());
        } catch (PaymentGatewayException error) {
            boolean invalidRequest = error.kind() == PaymentGatewayException.Kind.INVALID_REQUEST;
            if (invalidRequest || error.kind() == PaymentGatewayException.Kind.NOT_DISPATCHED) {
                boolean expired = Objects.requireNonNull(transactions.execute(
                    tx -> rejectUndispatchedPayment(attempt, invalidRequest)));
                if (expired) throw ApiFailure.conflict("reservation_expired");
                throw invalidRequest ? ApiFailure.invalid() : ApiFailure.unavailable();
            }
            // The provider may have received the request. Keep this attempt for verification by reference.
            throw ApiFailure.unavailable();
        }
    }

    private PaymentAttempt paymentAttemptView(UUID id) {
        // Hosted checkout creation can outlive the hold; evaluate what may be returned after the provider call.
        return jdbc.sql("SELECT " + PAYMENT_ATTEMPT_VIEW_COLUMNS + """
            FROM payment_attempts attempt JOIN orders ON orders.id = attempt.order_id
            WHERE attempt.id = ?
            """).param(id).query(OrderService::paymentAttemptRow).single();
    }

    private boolean rejectUndispatchedPayment(Attempt attempt, boolean invalidRequest) {
        StoredOrder order = owned(null, attempt.orderId(), true);
        boolean expired = !order.reservationExpiresAt().isAfter(databaseNow());
        Attempt current = latest(order.id());
        if (current == null || !current.id().equals(attempt.id()) || !order.paymentStatus().equals("processing")
            || !order.status().equals("awaiting_payment")) return expired;
        int closed = jdbc.sql("""
            UPDATE payment_attempts SET status = 'declined'
            WHERE id = ? AND status = 'processing' AND checkout_url IS NULL AND provider_transaction_id IS NULL
            """).param(attempt.id()).update();
        if (closed == 1) {
            jdbc.sql("UPDATE orders SET status = ?, payment_status = 'declined' WHERE id = ?")
                .params(expired || invalidRequest ? "cancelled" : "awaiting_payment", order.id()).update();
        }
        return expired;
    }

    private PaymentStart preparePayment(UUID guest, UUID id, String key) {
        StoredOrder order = owned(guest, id, true);
        requireSupportedTotal(order.total());
        Attempt existing = jdbc.sql("SELECT * FROM payment_attempts WHERE order_id = ? AND request_key = ?")
            .params(id, key).query(OrderService::attemptRow).optional().orElse(null);
        if (existing != null) return new PaymentStart(existing, order, false);
        if (statusAt(order, databaseNow()).equals("cancelled")) throw ApiFailure.conflict("reservation_expired");
        if (order.paymentStatus().equals("processing")) throw ApiFailure.conflict("payment_pending");
        if (!order.status().equals("awaiting_payment")) throw ApiFailure.conflict("conflict");

        UUID reference = UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO payment_attempts (id, order_id, request_key, status)
            VALUES (?, ?, ?, 'processing')
            """).params(reference, id, key).update();
        jdbc.sql("UPDATE orders SET payment_status = 'processing' WHERE id = ?").param(id).update();
        return new PaymentStart(new Attempt(reference, id, "processing", null), order, true);
    }

    public void settlePayment(VerifiedPayment payment) {
        if (payment == null || payment.result() == null || payment.transactionId() == null
            || payment.transactionId().isBlank()) throw ApiFailure.invalid();
        UUID attemptId = ApiFailure.uuid(payment.reference(), ApiFailure.notFound());
        transactions.executeWithoutResult(tx -> {
            Attempt observed = jdbc.sql("SELECT * FROM payment_attempts WHERE id = ?").param(attemptId)
                .query(OrderService::attemptRow).optional().orElseThrow(ApiFailure::notFound);
            StoredOrder order = owned(null, observed.orderId(), true);
            Attempt attempt = jdbc.sql("SELECT * FROM payment_attempts WHERE id = ? FOR UPDATE").param(attemptId)
                .query(OrderService::attemptRow).single();
            if (order.total() != payment.amount() || !CURRENCY.equals(payment.currency())) {
                throw ApiFailure.conflict(PAYMENT_MISMATCH);
            }
            if (payment.result() == PaymentResult.PROCESSING || (payment.result() == PaymentResult.DECLINED && !localPayments)) {
                return;
            }

            Attempt active = latest(order.id());
            boolean current = active != null && active.id().equals(attempt.id());
            if (attempt.status().equals("paid")) {
                if (payment.result() == PaymentResult.PAID
                    && !Objects.equals(attempt.providerTransactionId(), payment.transactionId())) {
                    recordPaymentException(attemptId, payment.transactionId(), "duplicate_transaction");
                }
                return;
            }
            if (payment.result() == PaymentResult.DECLINED) {
                if (!current || !attempt.status().equals("processing")) return;
                jdbc.sql("UPDATE payment_attempts SET status = 'declined', checkout_url = NULL WHERE id = ?")
                    .param(attemptId).update();
                jdbc.sql("UPDATE orders SET payment_status = 'declined' WHERE id = ?").param(order.id()).update();
                return;
            }

            boolean acceptable = current && attempt.status().equals("processing") && reservationStillValid(order);
            jdbc.sql("""
                UPDATE payment_attempts SET status = 'paid', provider_transaction_id = ?, checkout_url = NULL,
                    verified_at = clock_timestamp()
                WHERE id = ?
                """).params(payment.transactionId(), attemptId).update();
            if (acceptable) {
                jdbc.sql("""
                        UPDATE orders SET status = 'accepted', payment_status = 'paid', pickup_code = ?,
                            accepted_at = clock_timestamp() WHERE id = ?
                        """)
                    .params(String.format(Locale.ROOT, "%06d", RANDOM.nextInt(1_000_000)), order.id()).update();
                return;
            }
            recordPaymentException(attemptId, payment.transactionId(),
                current ? "unavailable_reservation" : "superseded_attempt");
            if (current && !order.paymentStatus().equals("paid")) {
                jdbc.sql("UPDATE orders SET status = 'cancelled', payment_status = 'refund_pending' WHERE id = ?")
                    .param(order.id()).update();
            }
        });
    }

    private boolean reservationStillValid(StoredOrder order) {
        // Check the hold with PostgreSQL's clock after acquiring the slot lock used by reservations and imports.
        Catalog.SlotData slot = catalog.slot(order.storeId(), order.slotId(), true);
        return order.startsAt().equals(slot.startsAt()) && order.endsAt().equals(slot.endsAt())
            && statusAt(order, databaseNow()).equals("awaiting_payment");
    }

    private void recordPaymentException(UUID attempt, String transaction, String reason) {
        jdbc.sql("""
            INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at)
            VALUES (?, ?, ?, now()) ON CONFLICT (attempt_id, provider_transaction_id) DO NOTHING
            """).params(attempt, transaction, reason).update();
    }

    void setLocalPayment(UUID guest, UUID orderId, UUID attemptId, PaymentResult result) {
        if (!localPayments || result == PaymentResult.PROCESSING) throw ApiFailure.invalid();
        transactions.executeWithoutResult(tx -> {
            StoredOrder order = owned(guest, orderId, true);
            Attempt attempt = latest(orderId);
            if (attempt == null || !attempt.id().equals(attemptId) || !attempt.status().equals("processing")) {
                throw ApiFailure.conflict("conflict");
            }
            settlePayment(new VerifiedPayment(attemptId.toString(), "local-" + attemptId, order.total(), CURRENCY, result));
        });
    }

    private boolean claimVerification(UUID attempt) {
        return jdbc.sql("""
            UPDATE payment_attempts p SET last_checked_at = now()
            FROM orders o
            WHERE p.order_id = o.id AND p.id = ? AND p.status = 'processing'
              AND (p.last_checked_at IS NULL OR p.last_checked_at <= now() - CASE
                  WHEN o.reservation_expires_at <= now() - make_interval(hours => ?) THEN make_interval(secs => ?)
                  ELSE interval '15 seconds' END)
            """).params(attempt, AUTOMATIC_RECONCILIATION_WINDOW_HOURS, OVERDUE_PAYMENT_CHECK_COOLDOWN_SECONDS).update() > 0;
    }

    private OrderSnapshot recoverSnapshot(UUID guest, String key) {
        return jdbc.sql(ORDER_SNAPSHOT + "WHERE orders.guest_session_id = ? AND orders.request_key = ?")
            .params(guest, key).query(this::snapshotRow).optional().orElse(null);
    }

    private OrderSnapshot ownedSnapshot(UUID guest, UUID id) {
        return jdbc.sql(ORDER_SNAPSHOT + "WHERE orders.id = ? " + CHECKOUT_GUEST)
            .params(id, guest, guest).query(this::snapshotRow).optional().orElseThrow(ApiFailure::notFound);
    }

    private StoredOrder owned(UUID guest, UUID id, boolean lock) {
        var sql = jdbc.sql(ORDER + (guest != null ? " " + CHECKOUT_GUEST : "") + (lock ? " FOR UPDATE" : ""))
            .param(id);
        if (guest != null) sql.params(guest, guest);
        return sql.query(this::orderRow).optional().orElseThrow(ApiFailure::notFound);
    }

    private StoredOrder visible(UUID guest, UUID id) {
        return jdbc.sql(ORDER + " " + VISIBLE_TO_GUEST)
            .params(id, guest, guest).query(this::orderRow).optional().orElseThrow(ApiFailure::notFound);
    }

    private static Order view(OrderSnapshot snapshot, boolean exposeCheckout) {
        StoredOrder order = snapshot.order();
        PaymentAttempt attempt = snapshot.attempt();
        if (attempt != null && !exposeCheckout) attempt = new PaymentAttempt(attempt.id(), attempt.status(), null);
        return new Order(order.id(), order.storeId(), order.slotId(), order.lines(), order.total(), order.tax(),
            CURRENCY, order.paymentStatus(), statusAt(order, snapshot.checkedAt()), order.pickupCode(),
            order.receiptStatus(), order.receiptUrl(), attempt, order.createdAt(),
            order.reservationExpiresAt(), order.startsAt(), order.endsAt());
    }

    private Attempt latest(UUID id) {
        return jdbc.sql(LATEST_ATTEMPT).param(id).query(OrderService::attemptRow).optional().orElse(null);
    }

    private StoredQuote quoteRow(ResultSet rs, int row) throws SQLException {
        return new StoredQuote(rs.getObject("id", UUID.class), rs.getString("store_id"), rs.getString("slot_id"),
            readTime(rs, "pickup_starts_at"), readTime(rs, "pickup_ends_at"), json.read(rs.getString("lines"), CART_LINES),
            rs.getLong("total"), rs.getLong("tax"), readTime(rs, "expires_at"));
    }

    private StoredOrder orderRow(ResultSet rs, int row) throws SQLException {
        CheckoutChannel channel = CheckoutChannel.valueOf(rs.getString("checkout_channel").toUpperCase(Locale.ROOT));
        String recoveredGuest = channel == CheckoutChannel.MOBILE ? "mobile_checkout_guest_session_id" : "web_checkout_guest_session_id";
        return new StoredOrder(rs.getObject("id", UUID.class), rs.getObject("quote_id", UUID.class),
            rs.getObject("guest_session_id", UUID.class), rs.getString("store_id"), rs.getString("slot_id"),
            rs.getString("phone"), rs.getString("email"), json.read(rs.getString("lines"), CART_LINES),
            rs.getLong("total"), rs.getLong("tax"), rs.getString("status"), rs.getString("payment_status"),
            rs.getString("pickup_code"), rs.getString("receipt_status"), rs.getString("receipt_url"),
            readTime(rs, "created_at"), readTime(rs, "reservation_expires_at"),
            readTime(rs, "pickup_starts_at"), readTime(rs, "pickup_ends_at"),
            channel, rs.getObject(recoveredGuest, UUID.class));
    }

    private OrderSnapshot snapshotRow(ResultSet rs, int row) throws SQLException {
        return new OrderSnapshot(orderRow(rs, row), paymentAttemptRow(rs, row), readTime(rs, "checked_at"));
    }

    private static PaymentAttempt paymentAttemptRow(ResultSet rs, int row) throws SQLException {
        UUID attemptId = rs.getObject("attempt_id", UUID.class);
        return attemptId == null ? null
            : new PaymentAttempt(attemptId, rs.getString("attempt_status"), rs.getString("checkout_url"));
    }

    private static Attempt attemptRow(ResultSet rs, int row) throws SQLException {
        return new Attempt(rs.getObject("id", UUID.class), rs.getObject("order_id", UUID.class),
            rs.getString("status"), rs.getString("provider_transaction_id"));
    }

    private Instant databaseNow() {
        return jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single().toInstant();
    }

    private static String statusAt(StoredOrder order, Instant now) {
        return order.status().equals("awaiting_payment") && !order.reservationExpiresAt().isAfter(now)
            ? "cancelled" : order.status();
    }

    static void validateKey(String key) {
        if (key == null || !KEY.matcher(key).matches()) throw ApiFailure.invalid();
    }

    private static boolean isId(String value) {
        return value != null && CATALOG_ID.matcher(value).matches();
    }

    private static void validateQuote(QuoteInput input) {
        if (input == null || !isId(input.storeId()) || !isId(input.slotId())
            || input.lines() == null || input.lines().isEmpty() || input.lines().size() > 50) {
            throw ApiFailure.invalid();
        }
        var seen = new HashSet<List<String>>();
        for (CartLine line : input.lines()) {
            if (line == null || !isId(line.sku()) || line.quantity() < 1 || line.quantity() > 99
                || line.unitPrice() < 0 || line.unitPrice() > MAX_PRICE || line.modifierIds() == null
                || line.modifierIds().size() > 25 || line.modifierIds().stream().anyMatch(id -> !isId(id))
                || new HashSet<>(line.modifierIds()).size() != line.modifierIds().size()) throw ApiFailure.invalid();
            var identity = new java.util.ArrayList<String>();
            identity.add(line.sku());
            identity.addAll(line.modifierIds().stream().sorted().toList());
            if (!seen.add(identity)) throw ApiFailure.invalid();
        }
    }

    private static long total(List<CartLine> lines) {
        long total = 0;
        for (CartLine line : lines) {
            if (line.unitPrice() < 0 || line.unitPrice() > MAX_PRICE) throw ApiFailure.unavailable();
            total += line.unitPrice() * line.quantity();
        }
        return total;
    }

    private static void requireSupportedTotal(long total) {
        if (total > PaymentGateway.MAX_CHARGE_RWF) throw ApiFailure.invalid();
    }

    private static Instant earlier(Instant first, Instant second) {
        return first.isBefore(second) ? first : second;
    }
}
