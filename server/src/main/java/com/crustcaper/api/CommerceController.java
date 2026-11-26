package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
final class CommerceController {
    private static final String KEY = "Idempotency-Key";
    private final GuestSessions sessions;
    private final Catalog catalog;
    private final OrderService orders;
    private final CommerceJson json;

    CommerceController(GuestSessions sessions, Catalog catalog, OrderService orders, CommerceJson json) {
        this.sessions = sessions;
        this.catalog = catalog;
        this.orders = orders;
        this.json = json;
    }

    @GetMapping("/stores/{id}/menu")
    ResponseEntity<Menu> menu(@PathVariable String id, @RequestParam(required = false) String channel,
        @RequestParam(required = false) String locale,
        @RequestHeader(value = HttpHeaders.IF_NONE_MATCH, required = false) String currentTag) {
        if ((channel != null && !channel.equals("mobile") && !channel.equals("web"))
            || (locale != null && !locale.equals("en") && !locale.equals("rw"))) throw ApiFailure.invalid();
        Menu menu = catalog.menu(id);
        String tag = tag(menu);
        boolean notModified = currentTag != null && java.util.Arrays.stream(currentTag.split(","))
            .map(String::strip).anyMatch(value -> value.equals("*") || value.equals(tag) || value.equals("W/" + tag));
        var response = (notModified ? ResponseEntity.status(304) : ResponseEntity.ok())
            .eTag(tag).cacheControl(CacheControl.noCache())
            .header(AVAILABILITY_CHECKED_AT_HEADER, menu.availabilityCheckedAt().toString());
        return notModified ? response.build() : response.body(menu);
    }

    @PostMapping("/guest-sessions")
    ResponseEntity<GuestSession> guest() {
        return privateResponse(sessions.create());
    }

    @PostMapping("/guest-sessions/refresh")
    ResponseEntity<GuestSession> refresh(@RequestBody GuestRefresh input) {
        return privateResponse(sessions.refresh(input.refreshToken(), input.rotationKey()));
    }

    @PostMapping("/guest-sessions/revoke")
    ResponseEntity<Void> revoke(@RequestBody GuestRefresh input) {
        sessions.revoke(input.refreshToken(), input.rotationKey());
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @PostMapping("/quotes")
    ResponseEntity<Quote> quote(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestBody QuoteInput input) {
        return privateResponse(orders.createQuote(sessions.authenticate(bearer), input));
    }

    @PostMapping("/orders")
    ResponseEntity<Order> order(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestHeader(value = KEY, required = false) String key, @RequestBody OrderInput input) {
        return privateResponse(orders.createOrder(sessions.authenticate(bearer), key, input));
    }

    @GetMapping("/orders/recovery")
    ResponseEntity<Order> recover(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestHeader(value = KEY, required = false) String key) {
        return privateResponse(orders.recover(sessions.authenticate(bearer), key));
    }

    @GetMapping("/orders/{id}")
    ResponseEntity<OrderService.ReadOrder> order(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id) {
        return privateResponse(orders.getMobileOrder(sessions.authenticate(bearer), ApiFailure.uuid(id, ApiFailure.notFound())));
    }

    @PostMapping("/orders/{id}/reorder")
    ResponseEntity<Reorder> reorder(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id) {
        return privateResponse(orders.reorder(sessions.authenticate(bearer), ApiFailure.uuid(id, ApiFailure.notFound())));
    }

    @PostMapping("/orders/{id}/payments")
    ResponseEntity<PaymentAttempt> pay(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestHeader(value = KEY, required = false) String key, @PathVariable String id) {
        return privateResponse(orders.startPayment(sessions.authenticate(bearer), ApiFailure.uuid(id, ApiFailure.notFound()), key));
    }

    static <T> ResponseEntity<T> privateResponse(T content) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(content);
    }

    private String tag(Menu menu) {
        try {
            byte[] encoded = json.write(menu).getBytes(StandardCharsets.UTF_8);
            return "\"" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(encoded)) + "\"";
        } catch (NoSuchAlgorithmException ignored) {
            throw ApiFailure.unavailable();
        }
    }
}
