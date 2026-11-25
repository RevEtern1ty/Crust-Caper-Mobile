package com.crustcaper.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class ApiModels {
    static final String CURRENCY = "RWF";

    private ApiModels() {}

    public record Localized(String en, String rw) {}
    public record Modifier(String id, Localized name, long price) {}
    public record Product(
        String sku, Localized name, Localized description, List<Localized> ingredients,
        List<Localized> allergens, String category, long price, boolean available,
        List<Modifier> modifiers, @JsonInclude(JsonInclude.Include.NON_NULL) String photoUrl
    ) {}
    public record Store(
        String id, Localized name, Localized area, boolean open, Localized hours,
        @JsonInclude(JsonInclude.Include.NON_NULL) String supportUrl,
        @JsonInclude(JsonInclude.Include.NON_NULL) String directionsUrl
    ) {}
    public record Slot(String id, Instant startsAt, Instant endsAt, boolean available) {}
    public record Menu(String version, Instant updatedAt, Store store, List<Product> products, List<Slot> slots) {}
    public record GuestSession(String accessToken, Instant expiresAt, String refreshToken, Instant refreshExpiresAt) {}
    public record GuestRefresh(String refreshToken) {}
    public record CartLine(String sku, List<String> modifierIds, int quantity, long unitPrice) {}
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record QuoteChange(String kind, String sku, Long previousPrice, Long currentPrice) {}
    public record Reorder(List<CartLine> lines, List<QuoteChange> changes) {}
    public record QuoteInput(String storeId, String slotId, List<CartLine> lines) {}
    public record OrderInput(String quoteId, String phone, String email) {}
    public record Quote(
        UUID quoteId, String storeId, String slotId, List<CartLine> lines, long subtotal, long tax,
        long total, String currency, Instant expiresAt, List<QuoteChange> changes,
        Instant pickupStartsAt, Instant pickupEndsAt
    ) {}
    public record PaymentAttempt(UUID id, String status, String checkoutUrl) {}
    public record Order(
        UUID id, String storeId, String slotId, List<CartLine> lines, long total, long tax,
        String currency, String paymentStatus, String status, String pickupCode, String receiptStatus,
        String receiptUrl, PaymentAttempt paymentAttempt, Instant createdAt, Instant reservationExpiresAt,
        Instant pickupStartsAt, Instant pickupEndsAt
    ) {}
    public record Problem(String type, String title, int status, String code) {}
}
