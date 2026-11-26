package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.Order;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonUnwrapped;

record WebOrder(@JsonUnwrapped Order order, @JsonInclude(JsonInclude.Include.NON_NULL) Boolean recoveryReadOnly) {
    static WebOrder from(Order order, boolean readOnly) {
        if (order.receiptUrl() != null) {
            String receiptSuffix = "/orders/" + order.id() + "/receipt";
            boolean hasOriginal = order.receiptStatus().equals("issued") || order.receiptStatus().equals("corrected");
            String receiptUrl = hasOriginal && order.receiptUrl().equals("/api/v1" + receiptSuffix)
                ? "/api/v1/web" + receiptSuffix : null;
            order = new Order(order.id(), order.storeId(), order.slotId(), order.lines(), order.total(), order.tax(),
                order.currency(), order.paymentStatus(), order.status(), order.pickupCode(), order.receiptStatus(),
                receiptUrl, order.paymentAttempt(), order.createdAt(), order.reservationExpiresAt(), order.pickupStartsAt(),
                order.pickupEndsAt());
        }
        return new WebOrder(order, readOnly ? Boolean.TRUE : null);
    }
}
