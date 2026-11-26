package com.crustcaper.api.operator;

import java.nio.charset.StandardCharsets;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operator/reconciliation")
final class OperatorReconciliationController {
    private static final MediaType CSV = new MediaType("text", "csv", StandardCharsets.UTF_8);

    private final OperatorReconciliation reconciliation;

    OperatorReconciliationController(OperatorReconciliation reconciliation) {
        this.reconciliation = reconciliation;
    }

    @GetMapping
    ResponseEntity<OperatorReconciliation.Report> summary(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestParam(value = "date", required = false) String date) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(reconciliation.summary(authorization, date));
    }

    @GetMapping("/export")
    ResponseEntity<String> export(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestParam(value = "date", required = false) String date) {
        var report = reconciliation.export(authorization, date);
        var disposition = ContentDisposition.attachment()
                .filename("crustcaper-reconciliation-" + report.date() + ".csv").build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(CSV)
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString()).body(report.content());
    }
}
