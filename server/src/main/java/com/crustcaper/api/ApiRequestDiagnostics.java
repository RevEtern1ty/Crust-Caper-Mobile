package com.crustcaper.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public final class ApiRequestDiagnostics extends OncePerRequestFilter {
    public static final String HEADER = "X-Request-ID";
    private static final Logger LOG = LoggerFactory.getLogger(ApiRequestDiagnostics.class);
    private static final String STATE = ApiRequestDiagnostics.class.getName() + ".state";
    private static final String CATEGORY = ApiRequestDiagnostics.class.getName() + ".category";
    private static final List<String> CORS_HEADERS = List.of(HttpHeaders.VARY,
        HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS,
        HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS);
    private static final ApiModels.Problem UNEXPECTED_PROBLEM = new ApiModels.Problem(
        "urn:crustcaper:problem:service_unavailable", "Internal Server Error", 500, "service_unavailable");
    private final CommerceErrorMetrics metrics;
    private final CommerceJson json;

    private record RequestState(String id, long startedAt) {}

    ApiRequestDiagnostics(CommerceErrorMetrics metrics, CommerceJson json) {
        this.metrics = metrics;
        this.json = json;
    }

    static void markFailure(HttpServletRequest request, String category) {
        request.setAttribute(CATEGORY, category);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String root = request.getContextPath() + "/api/v1";
        String path = request.getRequestURI();
        return !path.equals(root) && !path.startsWith(root + "/");
    }

    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        RequestState state = (RequestState) request.getAttribute(STATE);
        if (state == null) {
            state = new RequestState(UUID.randomUUID().toString(), System.nanoTime());
            request.setAttribute(STATE, state);
        }
        response.setHeader(HEADER, state.id());
        try {
            chain.doFilter(request, response);
        } catch (ServletException | RuntimeException failure) {
            if (NestedExceptionUtils.getMostSpecificCause(failure) instanceof IOException) throw failure;
            if (response.isCommitted()) {
                if (isServerError(response.getStatus())) observe(request, response, state);
                throw failure;
            }
            // Finish the API response here so the ID, HTTP status and safe log event describe the same failure.
            writeUnexpectedProblem(response, state.id());
            markFailure(request, "unexpected");
        }
        if (!isAsyncStarted(request)) observe(request, response, state);
    }

    private void observe(HttpServletRequest request, HttpServletResponse response, RequestState state) {
        int status = response.getStatus();
        boolean serverError = isServerError(status);
        Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (!request.getMethod().equals("OPTIONS") && (serverError || (status >= 200 && status < 400 && pattern != null))) {
            metrics.record(serverError);
        }
        if (serverError) {
            // The MVC mapping contains placeholders. Never substitute the actual request URI.
            Object category = request.getAttribute(CATEGORY);
            LOG.warn("api_request_failed requestId={} route={} method={} status={} category={} elapsedMs={}",
                state.id(), pattern == null ? "unmatched" : pattern, method(request), status,
                category == null ? "unavailable" : category,
                TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - state.startedAt()));
        }
    }

    private void writeUnexpectedProblem(HttpServletResponse response, String id) throws IOException {
        byte[] body = json.write(UNEXPECTED_PROBLEM).getBytes(StandardCharsets.UTF_8);
        Map<String, List<String>> cors = new LinkedHashMap<>();
        for (String name : CORS_HEADERS) cors.put(name, List.copyOf(response.getHeaders(name)));
        response.reset();
        cors.forEach((name, values) -> values.forEach(value -> response.addHeader(name, value)));
        response.setHeader(HEADER, id);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        response.setContentLength(body.length);
        response.getOutputStream().write(body);
    }

    private static boolean isServerError(int status) {
        return status >= 500 && status < 600;
    }

    private static String method(HttpServletRequest request) {
        return switch (request.getMethod()) {
            case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS" -> request.getMethod();
            default -> "OTHER";
        };
    }
}
