package com.crustcaper.api.config;

import com.crustcaper.api.ApiRequestDiagnostics;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@Profile("local & !stage & !prod & !production")
class LocalWebApiConfiguration implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/v1/**")
            .allowedOriginPatterns("http://127.0.0.1:[*]", "http://localhost:[*]")
            .allowedMethods("GET", "POST")
            .allowedHeaders("Content-Type", "Authorization", "Idempotency-Key")
            .exposedHeaders(ApiRequestDiagnostics.HEADER)
            .maxAge(600);
    }
}
