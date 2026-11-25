package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.Login;
import com.crustcaper.api.operator.OperatorModels.OrderView;
import com.crustcaper.api.operator.OperatorModels.PaymentReview;
import com.crustcaper.api.operator.OperatorModels.Queue;
import com.crustcaper.api.operator.OperatorModels.Session;
import com.crustcaper.api.operator.OperatorModels.StatusInput;
import com.crustcaper.api.operator.OperatorReceipts.ReceiptOrder;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operator")
final class OperatorController {
    private final OperatorSessions sessions;
    private final OperatorOrders orders;
    private final OperatorReceipts receipts;

    OperatorController(OperatorSessions sessions, OperatorOrders orders, OperatorReceipts receipts) {
        this.sessions = sessions;
        this.orders = orders;
        this.receipts = receipts;
    }

    @PostMapping("/sessions")
    ResponseEntity<Session> login(@RequestBody Login input) {
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore()).body(sessions.open(input));
    }

    @DeleteMapping("/sessions/current")
    ResponseEntity<Void> logout(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        sessions.revoke(authorization);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @GetMapping("/orders")
    ResponseEntity<Queue> queue(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(orders.active(authorization));
    }

    @GetMapping("/payment-exceptions")
    ResponseEntity<PaymentReview> paymentReview(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(orders.paymentReview(authorization));
    }

    @GetMapping("/receipts")
    ResponseEntity<List<ReceiptOrder>> receipts(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(receipts.pendingAndRecent(authorization));
    }

    @PutMapping("/orders/{id}/receipt")
    ResponseEntity<ReceiptOrder> attachReceipt(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable String id, HttpServletRequest request) {
        String reference = request.getHeader("X-Receipt-Reference");
        String total = request.getHeader("X-Receipt-Total-RWF");
        receipts.preflight(authorization, id, reference, total);
        byte[] document = ReceiptPdf.read(request);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(receipts.attach(authorization, id, reference, total, document));
    }

    @PostMapping("/orders/{id}/status")
    ResponseEntity<OrderView> change(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
                                     @PathVariable String id, @RequestBody StatusInput input) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(orders.change(authorization, id, input));
    }
}
