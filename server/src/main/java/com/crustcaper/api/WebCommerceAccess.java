package com.crustcaper.api;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.UUID;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration(proxyBeanMethods = false)
class WebCommerceAccess implements WebMvcConfigurer, HandlerInterceptor {
    static final String GUEST_ATTRIBUTE = "crustcaper.web.guest";
    private final WebGuestSessions sessions;

    WebCommerceAccess(WebGuestSessions sessions) {
        this.sessions = sessions;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/v1/web/**")
            .excludePathPatterns("/api/v1/web/session");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        if (request.getAttribute(GUEST_ATTRIBUTE) != null) return true;

        UUID guest = switch (request.getMethod()) {
            case "GET", "HEAD" -> sessions.authenticate(request);
            default -> sessions.authenticateWrite(request);
        };
        request.setAttribute(GUEST_ATTRIBUTE, guest);
        return true;
    }
}
