package com.crustcaper.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
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
    private final CommerceErrorMetrics metrics;

    private record RequestState(String id, long startedAt) {}

    ApiRequestDiagnostics(CommerceErrorMetrics metrics) {
        this.metrics = metrics;
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
            // The container renders the error after this dispatch. Count it before that dispatch.
            if (!request.getMethod().equals("OPTIONS")
                    && (isServerError(response.getStatus()) || (!response.isCommitted()
                        && !(NestedExceptionUtils.getMostSpecificCause(failure) instanceof IOException)))) {
                metrics.record(true);
            }
            throw failure;
        }
        if (isAsyncStarted(request)) return;

        int status = response.getStatus();
        boolean serverError = isServerError(status);
        Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (!request.getMethod().equals("OPTIONS") && (serverError || (status >= 200 && status < 400 && pattern != null))) {
            metrics.record(serverError);
        }
        if (status >= 500) {
            // The MVC mapping contains placeholders. Never substitute the actual request URI.
            Object category = request.getAttribute(CATEGORY);
            LOG.warn("api_request_failed requestId={} route={} method={} status={} category={} elapsedMs={}",
                state.id(), pattern == null ? "unmatched" : pattern, method(request), status,
                category == null ? "unavailable" : category,
                TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - state.startedAt()));
        }
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
