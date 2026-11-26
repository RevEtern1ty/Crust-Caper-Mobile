package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.AVAILABILITY_CHECKED_AT_HEADER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.hamcrest.Matchers.containsString;
import static org.mockito.Mockito.doThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.TransientDataAccessResourceException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.servlet.HandlerMapping;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@ExtendWith(OutputCaptureExtension.class)
class ApiRequestDiagnosticsIntegrationTest {
    private static final String MENU_ROUTE = "/api/v1/stores/{id}/menu";
    private static final String COMMERCE_ERRORS = "/actuator/commerceerrors";
    private static final MediaType ACTUATOR_JSON = MediaType.parseMediaType("application/vnd.spring-boot.actuator.v3+json");
    private static final String REQUEST_ID = "X-Request-ID";
    private static final String UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final String FAILURE_EVENT = "api_request_failed";
    private static final String ORIGIN = "http://127.0.0.1:41233";

    @Autowired MockMvc api;
    @Autowired ObjectMapper json;
    @Autowired ApiRequestDiagnostics diagnostics;
    @MockitoSpyBean Catalog catalog;

    @Test
    void databaseFailureRetainsProblemResponseAndLogsOneCorrelatedSafeEvent(CapturedOutput output) throws Exception {
        String store = "private-store-marker";
        String suppliedId = "00000000-0000-4000-8000-000000000042";
        String query = "private-query-marker";
        String authorization = "private-authorization-marker";
        String exceptionMessage = "private-database-exception-marker";
        Catalog target = AopTestUtils.getUltimateTargetObject(catalog);
        doThrow(new TransientDataAccessResourceException(exceptionMessage)).when(target).menu(store);

        var response = api.perform(get(MENU_ROUTE, store)
                .header(REQUEST_ID, suppliedId)
                .header(HttpHeaders.ORIGIN, ORIGIN)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + authorization)
                .queryParam("diagnostic", query))
            .andExpect(status().isServiceUnavailable())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(header().exists(REQUEST_ID))
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN))
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, containsString(REQUEST_ID)))
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, containsString(AVAILABILITY_CHECKED_AT_HEADER)))
            .andExpect(jsonPath("$.code").value("service_unavailable"))
            .andReturn().getResponse();

        String requestId = response.getHeader(REQUEST_ID);
        assertThat(requestId).matches(UUID_V4).isNotEqualTo(suppliedId);
        String captured = output.getAll();
        var failures = captured.lines().filter(line -> line.contains(FAILURE_EVENT)).toList();
        assertThat(failures).hasSize(1);
        assertThat(failures.getFirst())
            .contains(FAILURE_EVENT + " requestId=" + requestId + " route=" + MENU_ROUTE
                + " method=GET status=503 category=database")
            .containsPattern("elapsedMs=[0-9]+");
        assertThat(captured).doesNotContain(store, suppliedId, query, authorization, exceptionMessage);
        assertThat(response.getContentAsString()).doesNotContain(store, suppliedId, query, authorization, exceptionMessage);
    }

    @Test
    void healthyAndInvalidMenuRequestsHaveSeparateIdsWithoutFailureEvents(CapturedOutput output) throws Exception {
        var healthy = api.perform(get(MENU_ROUTE, "kigali")).andExpect(status().isOk())
            .andReturn().getResponse();
        var invalid = api.perform(get(MENU_ROUTE, "kigali").queryParam("channel", "invalid"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_input"))
            .andReturn().getResponse();

        String healthyId = healthy.getHeader(REQUEST_ID);
        assertThat(healthyId).matches(UUID_V4);
        assertThat(invalid.getHeader(REQUEST_ID)).matches(UUID_V4).isNotEqualTo(healthyId);
        assertThat(output.getAll()).doesNotContain(FAILURE_EVENT);
    }

    @Test
    void commerceSnapshotCountsCompletedRequestsAndExcludesExpectedClientFailuresAndProbeTraffic() throws Exception {
        Snapshot before = snapshot();
        assertThat(snapshot()).isEqualTo(before);

        var menu = api.perform(get(MENU_ROUTE, "kigali")).andExpect(status().isOk())
            .andExpect(header().exists(HttpHeaders.ETAG)).andReturn().getResponse();
        api.perform(get(MENU_ROUTE, "kigali").header(HttpHeaders.IF_NONE_MATCH, menu.getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isNotModified());
        assertCounts(before, 2, 0);

        api.perform(get(MENU_ROUTE, "kigali").queryParam("channel", "invalid")).andExpect(status().isBadRequest());
        api.perform(get("/api/v1/operator/orders")).andExpect(status().isUnauthorized());
        api.perform(get("/api/v1/no-such-commerce-route")).andExpect(status().isNotFound());
        api.perform(options(MENU_ROUTE, "kigali").header(HttpHeaders.ORIGIN, ORIGIN)
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET"))
            .andExpect(status().isOk());
        api.perform(head(COMMERCE_ERRORS)).andExpect(status().isOk());
        api.perform(get("/actuator/health/readiness")).andExpect(status().isOk());
        api.perform(get("/operator/index.html")).andExpect(status().isOk());
        api.perform(get("/api/v10/stores/kigali/menu")).andExpect(status().isNotFound());
        assertCounts(before, 2, 0);

        String store = "private-snapshot-store";
        Catalog target = AopTestUtils.getUltimateTargetObject(catalog);
        doThrow(new TransientDataAccessResourceException("private-snapshot-exception")).when(target).menu(store);
        api.perform(get(MENU_ROUTE, store).header(HttpHeaders.AUTHORIZATION, "Bearer private-snapshot-authorization")
                .queryParam("customer", "private-snapshot-query"))
            .andExpect(status().isServiceUnavailable());
        assertCounts(before, 3, 1);
        assertCounts(before, 3, 1);
    }

    @Test
    void failingServletWorkCountsOnceEvenWithoutAnMvcMappingAndIoFailuresDoNotCount() throws Exception {
        Snapshot before = snapshot();
        String store = "private-unhandled-store";
        Catalog target = AopTestUtils.getUltimateTargetObject(catalog);
        doThrow(new IllegalStateException("private-unhandled-exception")).when(target).menu(store);
        api.perform(get(MENU_ROUTE, store)).andExpect(status().isInternalServerError())
            .andExpect(jsonPath("$.code").value("service_unavailable"));
        assertCounts(before, 1, 1);

        var unmapped = new MockHttpServletRequest("GET", "/api/v1/fallback-probe");
        diagnostics.doFilter(unmapped, new MockHttpServletResponse(), (request, response) ->
            ((HttpServletResponse) response).setStatus(HttpServletResponse.SC_BAD_GATEWAY));
        assertCounts(before, 2, 2);

        var disconnected = new MockHttpServletRequest("GET", "/api/v1/disconnect-probe");
        assertThatThrownBy(() -> diagnostics.doFilter(disconnected, new MockHttpServletResponse(), (request, response) -> {
            throw new IOException("private-disconnect-marker");
        })).isInstanceOf(IOException.class);
        assertCounts(before, 2, 2);

        var wrappedDisconnect = new MockHttpServletRequest("GET", "/api/v1/wrapped-disconnect-probe");
        assertThatThrownBy(() -> diagnostics.doFilter(wrappedDisconnect, new MockHttpServletResponse(), (request, response) -> {
            throw new ServletException(new IOException("private-wrapped-disconnect-marker"));
        })).isInstanceOf(ServletException.class).hasRootCauseExactlyInstanceOf(IOException.class);
        assertCounts(before, 2, 2);

        var completed = new MockHttpServletRequest("GET", "/api/v1/committed-response-probe");
        completed.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, "/api/v1/committed-response-probe");
        var delivered = new MockHttpServletResponse();
        assertThatThrownBy(() -> diagnostics.doFilter(completed, delivered, (request, response) -> {
            ((HttpServletResponse) response).setStatus(HttpServletResponse.SC_OK);
            response.flushBuffer();
            throw new IllegalStateException("private-after-commit-marker");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(delivered.isCommitted()).isTrue();
        assertThat(delivered.getStatus()).isEqualTo(HttpServletResponse.SC_OK);
        assertCounts(before, 2, 2);
    }

    @Test
    void unexpectedFailureReplacesUncommittedSuccessHeadersAndBufferedBody() throws Exception {
        var request = new MockHttpServletRequest("GET", "/api/v1/fallback-probe");
        var response = new MockHttpServletResponse();
        diagnostics.doFilter(request, response, (ignored, result) -> {
            var partial = (HttpServletResponse) result;
            partial.setHeader(HttpHeaders.LOCATION, "https://fixture.example.test/old");
            partial.setHeader(HttpHeaders.SET_COOKIE, "fixture=discarded");
            partial.setHeader(HttpHeaders.CONTENT_DISPOSITION, "attachment");
            partial.setHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN);
            partial.setHeader(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, REQUEST_ID);
            partial.addHeader(HttpHeaders.VARY, HttpHeaders.ORIGIN);
            partial.addHeader(HttpHeaders.VARY, HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS);
            partial.setContentLength(17);
            partial.getWriter().write("fixture-old-body");
            throw new ServletException("fixture-private-exception");
        });
        assertThat(response.getStatus()).isEqualTo(500);
        assertThat(response.getHeader(REQUEST_ID)).matches(UUID_V4);
        assertThat(response.getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isEqualTo(ORIGIN);
        assertThat(response.getHeader(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS)).isEqualTo(REQUEST_ID);
        assertThat(response.getHeaders(HttpHeaders.VARY))
            .containsExactly(HttpHeaders.ORIGIN, HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS);
        assertThat(response.getHeader(HttpHeaders.LOCATION)).isNull();
        assertThat(response.getHeader(HttpHeaders.SET_COOKIE)).isNull();
        assertThat(response.getHeader(HttpHeaders.CONTENT_DISPOSITION)).isNull();
        assertThat(Integer.parseInt(response.getHeader(HttpHeaders.CONTENT_LENGTH)))
            .isEqualTo(response.getContentAsByteArray().length);
        assertThat(response.getContentAsString()).contains("\"code\":\"service_unavailable\"")
            .doesNotContain("fixture-old-body", "fixture-private-exception");
    }

    private void assertCounts(Snapshot baseline, long requests, long errors) throws Exception {
        Snapshot current = snapshot();
        assertThat(current.instanceId()).isEqualTo(baseline.instanceId());
        assertThat(current.requests()).isEqualTo(baseline.requests() + requests);
        assertThat(current.serverErrors()).isEqualTo(baseline.serverErrors() + errors);
    }

    private Snapshot snapshot() throws Exception {
        var response = api.perform(get(COMMERCE_ERRORS).accept(ACTUATOR_JSON)).andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(ACTUATOR_JSON)).andReturn().getResponse();
        JsonNode counters = json.readTree(response.getContentAsByteArray());
        assertThat(counters.propertyNames()).containsExactlyInAnyOrder("instanceId", "requests", "serverErrors");
        assertThat(counters.path("instanceId").asString()).matches(UUID_V4);
        assertThat(counters.path("requests").isIntegralNumber()).isTrue();
        assertThat(counters.path("serverErrors").isIntegralNumber()).isTrue();
        long requests = counters.path("requests").asLong();
        long errors = counters.path("serverErrors").asLong();
        assertThat(requests).isNotNegative();
        assertThat(errors).isBetween(0L, requests);
        assertThat(response.getContentAsString()).doesNotContain("private-", "/api/v1/");
        return new Snapshot(counters.path("instanceId").asString(), requests, errors);
    }

    private record Snapshot(String instanceId, long requests, long serverErrors) { }
}
