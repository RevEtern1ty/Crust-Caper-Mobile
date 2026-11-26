package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.AVAILABILITY_CHECKED_AT_HEADER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.mockito.Mockito.doThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@ExtendWith(OutputCaptureExtension.class)
class ApiRequestDiagnosticsIntegrationTest {
    private static final String MENU_ROUTE = "/api/v1/stores/{id}/menu";
    private static final String REQUEST_ID = "X-Request-ID";
    private static final String UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final String FAILURE_EVENT = "api_request_failed";
    private static final String ORIGIN = "http://127.0.0.1:41233";

    @Autowired MockMvc api;
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
}
