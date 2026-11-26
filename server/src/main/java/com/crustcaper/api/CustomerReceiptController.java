package com.crustcaper.api;

import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class CustomerReceiptController {
    private final GuestSessions sessions;
    private final OrderService orders;

    CustomerReceiptController(GuestSessions sessions, OrderService orders) {
        this.sessions = sessions;
        this.orders = orders;
    }

    @GetMapping("/api/v1/orders/{id}/receipt")
    ResponseEntity<byte[]> download(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
            @PathVariable String id) {
        return downloadForGuest(sessions.authenticate(bearer), id);
    }

    ResponseEntity<byte[]> downloadForGuest(UUID guest, String id) {
        UUID orderId = ApiFailure.uuid(id, ApiFailure.notFound());
        byte[] pdf = orders.receiptDocument(guest, orderId);
        String filename = "receipt-" + orderId.toString().substring(28) + ".pdf";
        return ResponseEntity.ok()
            .cacheControl(CacheControl.noStore().cachePrivate())
            .contentType(MediaType.APPLICATION_PDF)
            .contentLength(pdf.length)
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(filename).build().toString())
            .header("X-Content-Type-Options", "nosniff")
            .body(pdf);
    }
}
