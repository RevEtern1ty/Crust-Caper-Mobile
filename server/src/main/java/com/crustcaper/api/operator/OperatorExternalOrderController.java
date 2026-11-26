package com.crustcaper.api.operator;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operator")
final class OperatorExternalOrderController {
    private final OperatorExternalOrders orders;

    OperatorExternalOrderController(OperatorExternalOrders orders) {
        this.orders = orders;
    }

    @GetMapping("/external-order-channels")
    ResponseEntity<OperatorExternalOrders.Channels> channels(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(orders.channels(authorization));
    }

    @PostMapping(value = "/external-orders", consumes = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<OperatorExternalOrders.Order> register(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization, HttpServletRequest request) {
        OperatorExternalOrders.Registration result = orders.register(authorization, request);
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK)
            .cacheControl(CacheControl.noStore()).body(result.order());
    }

    @GetMapping("/external-orders/{id}")
    ResponseEntity<OperatorExternalOrders.Order> get(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization, @PathVariable String id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(orders.get(authorization, id));
    }

    @PostMapping(value = "/external-orders/{id}/status", consumes = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<OperatorExternalOrders.Order> change(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable String id, HttpServletRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(orders.change(authorization, id, request));
    }
}
