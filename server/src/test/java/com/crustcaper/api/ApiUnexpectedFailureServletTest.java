package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doThrow;

import com.crustcaper.api.payment.PaymentGateway.CheckoutChannel;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.AopTestUtils;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@ExtendWith(OutputCaptureExtension.class)
class ApiUnexpectedFailureServletTest {
    @LocalServerPort int port;
    @MockitoSpyBean Catalog catalog;

    @Test
    void unexpectedFailureReturnsASafeProblemAndCorrelatesTheExactHttpResponse(CapturedOutput output) throws Exception {
        String store = "fixture-private-store";
        String query = "fixture-private-query";
        String exception = "fixture-private-exception";
        String suppliedId = "00000000-0000-4000-8000-000000000042";
        String origin = "http://127.0.0.1:41233";
        Catalog target = AopTestUtils.getUltimateTargetObject(catalog);
        doThrow(new IllegalStateException(exception)).when(target).menu(store, CheckoutChannel.MOBILE);

        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                + "/api/v1/stores/" + store + "/menu?diagnostic=" + query))
            .timeout(Duration.ofSeconds(5)).header("Origin", origin).header("X-Request-ID", suppliedId).build();
        HttpResponse<String> response;
        try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()) {
            response = client.send(request, HttpResponse.BodyHandlers.ofString());
        }

        assertThat(response.statusCode()).isEqualTo(500);
        assertThat(response.headers().allValues("X-Request-ID")).hasSize(1);
        String requestId = response.headers().firstValue("X-Request-ID").orElseThrow();
        assertThat(requestId).matches("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
            .isNotEqualTo(suppliedId);
        String event = "api_request_failed requestId=" + requestId + " ";
        long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (!output.getAll().contains(event) && System.nanoTime() < deadline) Thread.sleep(20);
        assertThat(output.getAll().lines().filter(line -> line.contains(event)).toList()).singleElement()
            .satisfies(line -> assertThat(line)
                .contains("route=/api/v1/stores/{id}/menu method=GET status=500 category=unexpected")
                .containsPattern("elapsedMs=[0-9]+"));
        assertThat(response.headers().firstValue("Content-Type")).hasValue("application/problem+json");
        assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
        assertThat(response.headers().firstValue("Access-Control-Allow-Origin")).hasValue(origin);
        assertThat(response.headers().firstValue("Access-Control-Expose-Headers").orElseThrow()).contains("X-Request-ID");
        assertThat(response.body()).contains("\"code\":\"service_unavailable\"", "\"status\":500")
            .doesNotContain(store, query, exception, suppliedId);
        assertThat(output.getAll()).doesNotContain(store, query, exception, suppliedId);
    }
}
