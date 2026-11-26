package com.crustcaper.api.config;

import static com.crustcaper.api.ApiModels.AVAILABILITY_CHECKED_AT_HEADER;
import static com.crustcaper.api.ApiModels.NEXT_SALE_CHANGE_AT_HEADER;

import com.crustcaper.api.ApiRequestDiagnostics;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.web.servlet.config.annotation.CorsRegistration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@Profile("local & !stage & !prod & !production")
class LocalWebApiConfiguration implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        localOrigins(registry.addMapping("/api/v1/orders/{id}/erasure-request")).allowedMethods("GET", "PUT");
        localOrigins(registry.addMapping("/api/v1/{section:(?!web$).+}/**")).allowedMethods("GET", "POST");
    }

    private static CorsRegistration localOrigins(CorsRegistration registration) {
        return registration
            .allowedOriginPatterns("http://127.0.0.1:[*]", "http://localhost:[*]")
            .allowedHeaders("Content-Type", "Authorization", "Idempotency-Key")
            .exposedHeaders(ApiRequestDiagnostics.HEADER, AVAILABILITY_CHECKED_AT_HEADER, NEXT_SALE_CHANGE_AT_HEADER)
            .maxAge(600);
    }
}
