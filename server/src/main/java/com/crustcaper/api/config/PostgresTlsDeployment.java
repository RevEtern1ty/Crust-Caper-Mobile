package com.crustcaper.api.config;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;

/** Checks the deployed PostgreSQL configuration before either connection pool or migrations can connect. */
public final class PostgresTlsDeployment implements EnvironmentPostProcessor, Ordered {
    private static final String DATASOURCE_URL = "spring.datasource.url";
    private static final String FLYWAY_URL = "spring.flyway.url";
    private static final String HIKARI = "spring.datasource.hikari.";
    private static final String DRIVER = "org.postgresql.Driver";
    private static final Set<String> ALTERNATE_TRANSPORT = Set.of("ssl", "sslfactory", "sslfactoryarg",
        "sslhostnameverifier", "socketfactory", "socketfactoryarg", "service");

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (!environment.matchesProfiles("stage", "prod", "production")) return;
        Binder binder = Binder.get(environment);
        String url = setting(binder, DATASOURCE_URL);
        validateUrl(DATASOURCE_URL, url);
        validateUrl(FLYWAY_URL, setting(binder, FLYWAY_URL));

        requireDefault(binder, "spring.datasource.type", "com.zaxxer.hikari.HikariDataSource");
        requireDefault(binder, "spring.datasource.driver-class-name", DRIVER);
        requireDefault(binder, HIKARI + "driver-class-name", DRIVER);
        requireDefault(binder, "spring.flyway.driver-class-name", DRIVER);
        for (String property : Set.of(HIKARI + "jdbc-url", HIKARI + "data-source", HIKARI + "data-source-class-name",
            HIKARI + "data-source-jndi", "spring.datasource.jndi-name")) {
            requireDefault(binder, property, null);
        }
        if (System.getProperty("hikaricp.configurationFile") != null) {
            throw invalid("hikaricp.configurationFile", "external Hikari connection settings are unsupported");
        }
        validateJdbcProperties(binder, HIKARI + "data-source-properties");
        validateJdbcProperties(binder, "spring.flyway.jdbc-properties");
    }

    @Override
    public int getOrder() {
        // ConfigData and Spring's environment transformations must have completed.
        return Ordered.LOWEST_PRECEDENCE;
    }

    private static String setting(Binder binder, String property) {
        try {
            return binder.bind(property, String.class).orElse(null);
        } catch (RuntimeException ignored) {
            throw invalid(property, "cannot read the setting");
        }
    }

    private static void requireDefault(Binder binder, String property, String permittedValue) {
        String value = setting(binder, property);
        if (value != null && !value.equals(permittedValue)) {
            throw invalid(property, "alternate connection settings are unsupported");
        }
    }

    private static void validateJdbcProperties(Binder binder, String property) {
        Map<String, String> properties;
        try {
            properties = binder.bind(property, Bindable.mapOf(String.class, String.class)).orElse(Map.of());
        } catch (RuntimeException ignored) {
            throw invalid(property, "cannot read the JDBC properties");
        }
        for (String key : properties.keySet()) {
            String normalized = key.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
            if (ALTERNATE_TRANSPORT.contains(normalized)
                || Set.of("sslmode", "sslrootcert", "gssencmode").contains(normalized)) {
                throw invalid(property, "set verified TLS parameters only on the PostgreSQL JDBC URL");
            }
        }
    }

    private static void validateUrl(String property, String value) {
        Map<String, String> parameters = readParameters(property, value);
        if (!"verify-full".equals(parameters.get("sslmode"))) {
            throw invalid(property, "requires sslmode=verify-full");
        }
        String gssMode = parameters.getOrDefault("gssEncMode", "allow");
        if (!Set.of("allow", "disable").contains(gssMode)) {
            throw invalid(property, "GSS encryption cannot replace certificate-verified TLS");
        }
        validateCertificate(property, parameters.get("sslrootcert"));
    }

    private static Map<String, String> readParameters(String property, String value) {
        if (value == null || !value.startsWith("jdbc:postgresql://")) {
            throw invalid(property, "requires an explicit PostgreSQL JDBC URL");
        }
        URI url;
        try {
            url = URI.create(value.substring("jdbc:".length()));
        } catch (IllegalArgumentException ignored) {
            throw invalid(property, "requires a valid PostgreSQL JDBC URL");
        }
        String authority = url.getRawAuthority();
        if (authority == null || authority.contains("@") || url.getRawFragment() != null) {
            throw invalid(property, "requires an explicit PostgreSQL host without URL credentials or fragment");
        }
        Map<String, String> parameters = new HashMap<>();
        Set<String> seen = new HashSet<>();
        if (url.getRawQuery() == null) return parameters;
        for (String parameter : url.getRawQuery().split("&", -1)) {
            int equals = parameter.indexOf('=');
            String key = equals < 0 ? parameter : parameter.substring(0, equals);
            String normalized = key.toLowerCase(Locale.ROOT);
            if (!key.matches("[A-Za-z][A-Za-z0-9_]*") || !seen.add(normalized)
                || ALTERNATE_TRANSPORT.contains(normalized)) {
                throw invalid(property, "JDBC parameter names must be literal, distinct and use the default TLS transport");
            }
            try {
                parameters.put(key, equals < 0 ? "" : URLDecoder.decode(parameter.substring(equals + 1), StandardCharsets.UTF_8));
            } catch (IllegalArgumentException ignored) {
                throw invalid(property, "contains an invalid JDBC parameter");
            }
        }
        return parameters;
    }

    private static void validateCertificate(String property, String certificate) {
        if (certificate == null) {
            throw invalid(property, "requires an explicit sslrootcert");
        }
        try {
            Path path = Path.of(certificate);
            if (path.isAbsolute() && Files.isRegularFile(path)) {
                try (var input = Files.newInputStream(path)) {
                    if (!CertificateFactory.getInstance("X.509").generateCertificates(input).isEmpty()) return;
                }
            }
        } catch (IOException | CertificateException | IllegalArgumentException | SecurityException ignored) {
            // Leave the URL, certificate path and parser diagnostics out of startup errors.
        }
        throw invalid(property, "sslrootcert must be an absolute readable X.509 certificate file");
    }

    private static IllegalStateException invalid(String property, String reason) {
        return new IllegalStateException("PostgreSQL TLS configuration for " + property + ": " + reason);
    }
}
