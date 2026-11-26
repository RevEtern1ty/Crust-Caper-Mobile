package com.crustcaper.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Configuration;

class PostgresTlsDeploymentTest {
    private static final String DATABASE = "jdbc:postgresql://test-db.internal:5432/crustcaper";
    private static final String REJECTED = "PostgreSQL TLS configuration for ";
    private static final String PRIVATE_SENTINEL = "synthetic-password-must-not-appear";

    @TempDir Path temporaryDirectory;
    private Path certificate;
    private String verifiedUrl;

    @BeforeEach
    void prepareCertificate() throws Exception {
        certificate = temporaryDirectory.resolve("fixture CA.pem");
        Path trustStore = Path.of(System.getProperty("java.home"), "lib", "security", "cacerts");
        KeyStore trusted = KeyStore.getInstance(trustStore.toFile(), (char[]) null);
        Certificate example = trusted.getCertificate(trusted.aliases().nextElement());
        String pem = Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(example.getEncoded());
        Files.writeString(certificate, "-----BEGIN CERTIFICATE-----\n" + pem + "\n-----END CERTIFICATE-----\n");
        verifiedUrl = DATABASE + "?sslmode=verify-full&sslrootcert=" + encode(certificate.toString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"stage", "prod", "production", "production,metrics"})
    void rejectsAnUnauthenticatedConnectionBeforeSpringCreatesBeans(String profile) {
        assertThatThrownBy(() -> runAndClose(profile, DATABASE + "?user=" + PRIVATE_SENTINEL, Map.of()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining(REJECTED + "spring.datasource.url")
            .hasMessageNotContaining(PRIVATE_SENTINEL)
            .hasMessageNotContaining(DATABASE)
            .hasNoCause();
    }

    @ParameterizedTest
    @ValueSource(strings = {"stage", "prod", "production"})
    void acceptsVerifiedCaAndSeparateSecureFlywayUrl(String profile) {
        try (var context = run(profile, verifiedUrl + "&connectTimeout=4", Map.of(
            "spring.flyway.url", verifiedUrl + "&socketTimeout=15",
            "spring.datasource.hikari.data-source-properties[ApplicationName]", "crustcaper"))) {
            assertThat(context.isActive()).isTrue();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"local", "test"})
    void doesNotChangeOrdinaryLocalAndTestConnections(String profile) {
        try (var context = run(profile, DATABASE + "?sslmode=disable", Map.of())) {
            assertThat(context.isActive()).isTrue();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"sslmode=prefer", "sslmode=verify-ca", "sslmode=disable", "sslmode=verify-full",
        "sslmode=verify-full&sslrootcert=relative.pem", "sslmode=verify-full&sslrootcert=%00"})
    void rejectsWeakTlsOrAbsentAbsoluteCa(String parameters) {
        rejects("spring.datasource.url", DATABASE + "?" + parameters, Map.of());
    }

    @Test
    void rejectsMissingDirectoryAndInvalidCertificateFiles() throws IOException {
        rejects("spring.datasource.url", verifiedUrl.replace(encode(certificate.toString()),
            encode(temporaryDirectory.resolve("missing.pem").toString())), Map.of());
        rejects("spring.datasource.url", verifiedUrl.replace(encode(certificate.toString()),
            encode(temporaryDirectory.toString())), Map.of());
        Files.writeString(certificate, PRIVATE_SENTINEL);
        rejects("spring.datasource.url", verifiedUrl, Map.of());
    }

    @ParameterizedTest
    @ValueSource(strings = {"sslmode=verify-full", "SSLMODE=disable", "ssl%6dode=disable", "sslrootcert=/other.pem",
        "ssl=true", "sslfactory=alternate", "sslfactoryarg=value", "sslhostnameverifier=alternate",
        "socketFactory=alternate", "service=alternate", "gssEncMode=prefer", "gssEncMode=require"})
    void rejectsConflictingOrAlternateTransportParameters(String parameter) {
        rejects("spring.datasource.url", verifiedUrl + "&" + parameter, Map.of());
    }

    @Test
    void rejectsWeakFlywayOverrideEvenWithVerifiedRuntimeUrl() {
        rejects("spring.flyway.url", verifiedUrl, Map.of("spring.flyway.url", DATABASE + "?sslmode=disable"));
        rejects("spring.flyway.url", verifiedUrl, Map.of("spring.flyway.url", ""));
    }

    @ParameterizedTest
    @ValueSource(strings = {"spring.datasource.hikari.jdbc-url", "spring.datasource.hikari.data-source-class-name",
        "spring.datasource.hikari.data-source-jndi", "spring.datasource.jndi-name", "spring.datasource.type",
        "spring.datasource.driver-class-name", "spring.datasource.hikari.driver-class-name",
        "spring.flyway.driver-class-name", "spring.datasource.hikari.data-source-properties[sslfactory]",
        "spring.datasource.hikari.data-source-properties[sslMode]", "spring.flyway.jdbc-properties[gssEncMode]"})
    void rejectsAlternateConnectionSettings(String property) {
        rejects(property.split("\\[", 2)[0], verifiedUrl, Map.of(property, PRIVATE_SENTINEL));
    }

    private void rejects(String property, String url, Map<String, String> overrides) {
        assertThatThrownBy(() -> runAndClose("stage", url, overrides))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining(REJECTED + property)
            .hasMessageNotContaining(PRIVATE_SENTINEL)
            .hasMessageNotContaining(DATABASE)
            .hasNoCause();
    }

    private static void runAndClose(String profile, String url, Map<String, String> overrides) {
        try (var context = run(profile, url, overrides)) {
            assertThat(context.isActive()).isTrue();
        }
    }

    private static ConfigurableApplicationContext run(String profile, String url, Map<String, String> overrides) {
        SpringApplication application = new SpringApplication(EmptyApplication.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        application.setBannerMode(Banner.Mode.OFF);
        application.setLogStartupInfo(false);
        List<String> arguments = new ArrayList<>(List.of("--spring.profiles.active=" + profile,
            "--CRUSTCAPER_DB_URL=" + url));
        overrides.forEach((name, value) -> arguments.add("--" + name + "=" + value));
        return application.run(arguments.toArray(String[]::new));
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    @Configuration(proxyBeanMethods = false)
    static class EmptyApplication {}
}
