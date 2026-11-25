package com.crustcaper.api.payment;

import static com.crustcaper.api.payment.PaymentGatewayException.Kind.UNAVAILABLE;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.crustcaper.api.payment.RefundDirectory.ConfirmedRefund;
import com.crustcaper.api.payment.RefundDirectory.RefundRequest;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectMapper;

class FlutterwaveRefundDirectoryTest {
    private static final String REFUND_ID = "469462";
    private static final String TRANSACTION_ID = "394347475";
    private static final String REFUND_REFERENCE = "REF-POSTED-TEST";
    private static final String PROVIDER_KEY = "fixture-only-not-a-psp-credential";
    private static final String MISSING_PHONE = "+250700000000";
    private static final RefundRequest EXPECTED = new RefundRequest(REFUND_ID, TRANSACTION_ID, 9700, "RWF");

    private final List<Request> requests = new CopyOnWriteArrayList<>();
    private volatile Reply detail;
    private volatile Reply directory;
    private HttpServer fixture;
    private FlutterwavePaymentGateway gateway;

    @BeforeEach
    void startFixture() throws IOException {
        fixture = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fixture.createContext("/", this::respond);
        fixture.start();
        gateway = new FlutterwavePaymentGateway(URI.create("http://127.0.0.1:" + fixture.getAddress().getPort()),
                URI.create("https://example.test/payment-return"), PROVIDER_KEY, new ObjectMapper(), Clock.systemUTC(), 1000, 1000);
    }

    @AfterEach
    void stopFixture() {
        fixture.stop(0);
    }

    @ParameterizedTest
    @ValueSource(strings = {"completed-momo", "completed-mpgs", "completed-bank-transfer", "completed-offline", "completed-preauth"})
    void confirmsOfficialFinalStatusUsingOnlyAuthenticatedReadOnlyRequests(String status) {
        String row = refund(status);
        detail = new Reply(200, row);
        directory = new Reply(200, list(row));

        assertThat(gateway.confirm(EXPECTED)).contains(new ConfirmedRefund(REFUND_ID, TRANSACTION_ID, 9700, "RWF", status));
        assertThat(requests).containsExactly(
                new Request("GET", "/v3/refunds/" + REFUND_ID, "Bearer " + PROVIDER_KEY, ""),
                new Request("GET", "/v3/refunds?currency=RWF&flw_ref=" + REFUND_REFERENCE, "Bearer " + PROVIDER_KEY, ""));
    }

    @ParameterizedTest
    @ValueSource(strings = {"completed", "processing", "pending-momo", "pending-bank-transfer", "pending-mpgs", "failed", "successful", "succeeded"})
    void acceptsNeitherAnInitiatedRefundNorAnUndocumentedStatus(String status) {
        detail = new Reply(200, refund(status));

        assertThat(gateway.confirm(EXPECTED)).isEmpty();
        assertThat(requests).hasSize(1);
    }

    @Test
    void refusesWrongRefundOriginalTransactionFractionalPartialAndConflictingCurrency() {
        String row = refund("completed-mpgs");
        for (String altered : List.of(row.replace(REFUND_ID, "1111111"), row.replace(TRANSACTION_ID, "2222222"),
                row.replace("9700", "9699"), row.replace("9700", "9700.01"), row.replace("9700", "9701"),
                row.replace("\"id\":", "\"currency\":\"USD\",\"id\":"), row.replace(REFUND_REFERENCE, "unsafe&currency=USD"))) {
            detail = new Reply(200, altered);
            assertThat(gateway.confirm(EXPECTED)).isEmpty();
        }
        assertThat(requests).hasSize(7).allMatch(item -> item.path().equals("/v3/refunds/" + REFUND_ID));
    }

    @Test
    void requiresAnUnambiguousMatchingRwfDirectoryEntry() {
        String row = refund("completed-momo");
        detail = new Reply(200, row);
        for (String contents : List.of("", row + "," + row, row.replace(REFUND_REFERENCE, "DIFFERENT"),
                row.replace(TRANSACTION_ID, "2222222"), row.replace("completed-momo", "completed-mpgs"),
                row.replace("\"id\":", "\"currency\":\"NGN\",\"id\":"))) {
            directory = new Reply(200, list(contents));
            assertThat(gateway.confirm(EXPECTED)).isEmpty();
        }
        assertThat(requests).hasSize(12);
    }

    @Test
    void scopesMissingRefundAndOutageWithoutExposingProviderData() {
        detail = new Reply(404, MISSING_PHONE);
        assertThat(gateway.confirm(EXPECTED)).isEmpty();
        detail = new Reply(502, MISSING_PHONE);
        PaymentGatewayException failure = assertThrows(PaymentGatewayException.class, () -> gateway.confirm(EXPECTED));
        assertThat(failure.kind()).isEqualTo(UNAVAILABLE);
        assertThat(failure).hasNoCause().hasMessageNotContaining(MISSING_PHONE);
        assertThat(requests).hasSize(2);
    }

    private void respond(HttpExchange exchange) throws IOException {
        try (exchange) {
            String path = exchange.getRequestURI().toString();
            requests.add(new Request(exchange.getRequestMethod(), path, exchange.getRequestHeaders().getFirst("Authorization"),
                    new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            Reply reply = path.equals("/v3/refunds/" + REFUND_ID) ? detail : directory;
            byte[] bytes = reply.body().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(reply.status(), bytes.length);
            exchange.getResponseBody().write(bytes);
        }
    }

    private static String refund(String status) {
        return """
                {"id":%s,"amount_refunded":9700,"status":"%s","flw_ref":"%s","transaction_id":%s}
                """.formatted(REFUND_ID, status, REFUND_REFERENCE, TRANSACTION_ID);
    }

    private static String list(String content) {
        return "{\"status\":\"success\",\"data\":[" + content + "]}";
    }

    private record Request(String method, String path, String auth, String body) { }
    private record Reply(int status, String body) { }
}
