package com.crustcaper.api;

import static com.crustcaper.api.CommerceController.privateResponse;
import static com.crustcaper.api.WebCommerceAccess.GUEST_ATTRIBUTE;

import com.crustcaper.api.OrderPrivacyService.DataExport;
import com.crustcaper.api.OrderPrivacyService.ErasureStatus;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class OrderPrivacyController {
    private final GuestSessions sessions;
    private final OrderPrivacyService privacy;

    OrderPrivacyController(GuestSessions sessions, OrderPrivacyService privacy) {
        this.sessions = sessions;
        this.privacy = privacy;
    }

    @GetMapping("/api/v1/orders/{id}/data-export")
    ResponseEntity<DataExport> export(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id) {
        return exportForGuest(sessions.authenticate(bearer), id);
    }

    @GetMapping("/api/v1/web/orders/{id}/data-export")
    ResponseEntity<DataExport> exportForGuest(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id) {
        return privateResponse(privacy.export(guest, id));
    }

    @GetMapping("/api/v1/orders/{id}/erasure-request")
    ResponseEntity<ErasureStatus> erasure(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id) {
        return erasureForGuest(sessions.authenticate(bearer), id);
    }

    @GetMapping("/api/v1/web/orders/{id}/erasure-request")
    ResponseEntity<ErasureStatus> erasureForGuest(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id) {
        return privateResponse(privacy.erasure(guest, id, false));
    }

    @PutMapping("/api/v1/orders/{id}/erasure-request")
    ResponseEntity<ErasureStatus> submit(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String id) {
        return submitForGuest(sessions.authenticate(bearer), id);
    }

    @PutMapping("/api/v1/web/orders/{id}/erasure-request")
    ResponseEntity<ErasureStatus> submitForGuest(@RequestAttribute(GUEST_ATTRIBUTE) UUID guest, @PathVariable String id) {
        return privateResponse(privacy.erasure(guest, id, true));
    }
}
