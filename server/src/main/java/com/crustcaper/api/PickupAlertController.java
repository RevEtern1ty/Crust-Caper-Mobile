package com.crustcaper.api;

import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/orders/{id}/pickup-alert")
final class PickupAlertController {
    private static final String INSTALLATION = "X-Installation-Id";
    private static final Pattern CANONICAL_UUID =
        Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private final GuestSessions sessions;
    private final PickupAlerts alerts;

    PickupAlertController(GuestSessions sessions, PickupAlerts alerts) {
        this.sessions = sessions;
        this.alerts = alerts;
    }

    @GetMapping
    ResponseEntity<PickupAlerts.Status> get(
        @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestHeader(value = INSTALLATION, required = false) String installation, @PathVariable String id) {
        UUID guest = sessions.authenticate(bearer);
        return CommerceController.privateResponse(alerts.get(guest, ApiFailure.uuid(id, ApiFailure.notFound()), installation(installation)));
    }

    @PutMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<PickupAlerts.Status> enroll(
        @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestHeader(value = INSTALLATION, required = false) String installation, @PathVariable String id,
        @RequestBody PickupAlerts.Input input) {
        UUID guest = sessions.authenticate(bearer);
        return CommerceController.privateResponse(
            alerts.enroll(guest, ApiFailure.uuid(id, ApiFailure.notFound()), installation(installation), input));
    }

    @DeleteMapping
    ResponseEntity<Void> revoke(
        @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestHeader(value = INSTALLATION, required = false) String installation, @PathVariable String id) {
        UUID guest = sessions.authenticate(bearer);
        alerts.revoke(guest, ApiFailure.uuid(id, ApiFailure.notFound()), installation(installation));
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private static UUID installation(String value) {
        if (value == null || !CANONICAL_UUID.matcher(value).matches()) throw ApiFailure.invalid();
        return UUID.fromString(value);
    }
}
