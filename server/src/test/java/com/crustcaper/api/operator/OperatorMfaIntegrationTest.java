package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.operator.OperatorModels.Login;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorMfaIntegrationTest {
    private static final String FIXTURE_KEY = OperatorMfaFixture.KEY;
    private static final String ROOT = "/api/v1/operator";
    private static final String PASSWORD = "synthetic-mfa-fixture-password";
    private static final String PASSWORD_HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());
    private static final byte[] SEED = "12345678901234567890".getBytes(StandardCharsets.US_ASCII);

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired TransactionTemplate transactions;

    @DynamicPropertySource
    static void operatorMfaKey(DynamicPropertyRegistry registry) {
        OperatorMfaFixture.registerKey(registry);
    }

    @Test
    void anEnrolledLocalAccountRequiresMfaAndRejectsReplayingTheAcceptedCounter() throws Exception {
        Staff staff = account();
        String oldBearer = bearer(login(staff, PASSWORD, null).andExpect(status().isCreated()));
        queue(oldBearer).andExpect(status().isOk());
        assertThat(sessionCount(staff, true)).isZero();

        enroll(staff);
        queue(oldBearer).andExpect(status().isUnauthorized());
        login(staff, PASSWORD, null).andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("unauthenticated"));
        login(staff, PASSWORD, "invalid").andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("unauthenticated"));
        String code = codeAt(currentCounter());
        login(staff, "wrong-password", code).andExpect(status().isUnauthorized());
        assertThat(accountState(staff)).isEqualTo(new AccountState(3, null));
        assertThat(sessionCount(staff, true)).isZero();

        String bearer = bearer(login(staff, PASSWORD, code).andExpect(status().isCreated()));
        queue(bearer).andExpect(status().isOk());
        AccountState verified = accountState(staff);
        assertThat(verified.failures()).isZero();
        assertThat(verified.counter()).isNotNull();
        assertThat(sessionCount(staff, true)).isOne();

        login(staff, PASSWORD, code).andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("unauthenticated"));
        assertThat(accountState(staff)).isEqualTo(new AccountState(1, verified.counter()));
        assertThat(sessionCount(staff, true)).isOne();
    }

    @Test
    void aMandatoryProfileRejectsOldBearersAndChargesMissingEnrollmentToTheFailureBudget() throws Exception {
        Staff staff = account();
        String oldBearer = bearer(login(staff, PASSWORD, null).andExpect(status().isCreated()));
        OperatorSessions stage = sessions(FIXTURE_KEY, "local", "stage");

        assertThatThrownBy(() -> stage.requirePrincipal(oldBearer, false)).isInstanceOfSatisfying(OperatorFailure.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
        for (int i = 0; i < 5; i++) {
            assertThatThrownBy(() -> stage.open(new Login(staff.username(), PASSWORD)))
                .isInstanceOfSatisfying(OperatorFailure.class,
                        error -> assertThat(error.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
        }
        assertThatThrownBy(() -> stage.open(new Login(staff.username(), PASSWORD)))
            .isInstanceOfSatisfying(OperatorFailure.class,
                    error -> assertThat(error.status()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS));
        assertThat(accountState(staff)).isEqualTo(new AccountState(5, null));
        assertThat(sessionCount(staff, true)).isZero();
    }

    @Test
    void everyMandatoryProfileRequiresAValidKeyAndAKeylessTestProfileRejectsEnrolledAccounts() throws Exception {
        for (String profile : new String[] {"stage", "prod", "production"}) {
            assertThatThrownBy(() -> sessions("", "local", profile))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("CRUSTCAPER_OPERATOR_MFA_KEY");
        }
        assertThatThrownBy(() -> sessions("synthetic-invalid-key", "production"))
            .isInstanceOf(IllegalStateException.class).hasMessageContaining("CRUSTCAPER_OPERATOR_MFA_KEY")
            .hasMessageNotContaining("synthetic-invalid-key");
        for (String profile : new String[] {"local", "test"}) {
            assertThatThrownBy(() -> sessionsWithProvider("", "flutterwave", profile))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("CRUSTCAPER_OPERATOR_MFA_KEY");
        }

        Staff staff = account();
        enroll(staff);
        OperatorSessions stage = sessions(FIXTURE_KEY, "stage");
        String code = codeAt(currentCounter());
        String bearer = "Bearer " + stage.open(new Login(staff.username(), PASSWORD, code)).accessToken();
        assertThat(stage.requirePrincipal(bearer, false).id()).isEqualTo(staff.id());

        OperatorSessions keyless = sessions("", "test");
        assertThatThrownBy(() -> keyless.requirePrincipal(bearer, false)).isInstanceOfSatisfying(OperatorFailure.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
        assertThatThrownBy(() -> keyless.open(new Login(staff.username(), PASSWORD, code)))
            .isInstanceOfSatisfying(OperatorFailure.class,
                    error -> assertThat(error.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
        assertThat(sessionCount(staff, true)).isOne();
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void twoConcurrentLoginsWithOneCodeIssueExactlyOneBearer() throws Exception {
        Staff staff = transactions.execute(tx -> {
            Staff account = account();
            enroll(account);
            return account;
        });
        try (var workers = Executors.newFixedThreadPool(2)) {
            String code = codeAt(currentCounter());
            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch start = new CountDownLatch(1);
            Callable<Integer> contender = () -> {
                ready.countDown();
                assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                return login(staff, PASSWORD, code).andReturn().getResponse().getStatus();
            };
            var first = workers.submit(contender);
            var second = workers.submit(contender);
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(201, 401);
            assertThat(sessionCount(staff, true)).isOne();
            assertThat(sessionCount(staff, false)).isZero();
            assertThat(accountState(staff).failures()).isOne();
            assertThat(accountState(staff).counter()).isNotNull();
        } finally {
            transactions.executeWithoutResult(tx -> {
                jdbc.sql("DELETE FROM operator_sessions WHERE operator_id = ?").param(staff.id()).update();
                jdbc.sql("DELETE FROM operator_accounts WHERE id = ?").param(staff.id()).update();
                jdbc.sql("DELETE FROM stores WHERE id = ?").param(staff.store()).update();
            });
        }
    }

    private OperatorSessions sessions(String key, String... profiles) {
        return sessionsWithProvider(key, "local", profiles);
    }

    private OperatorSessions sessionsWithProvider(String key, String provider, String... profiles) {
        MockEnvironment environment = new MockEnvironment()
            .withProperty("crustcaper.operator.mfa-key", key)
            .withProperty("crustcaper.payment.provider", provider);
        environment.setActiveProfiles(profiles);
        return new OperatorSessions(jdbc, transactions, environment);
    }

    private Staff account() {
        UUID id = UUID.randomUUID();
        String store = "mfa-" + id;
        String username = "staff-" + id;
        jdbc.sql("""
                INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
                VALUES (?, '{}', '{}', '{}', true, 0, 'test')
                """).param(store).update();
        jdbc.sql("""
                INSERT INTO operator_accounts (id, store_id, username, role, password_hash)
                VALUES (?, ?, ?, 'manager', ?)
                """).params(id, store, username, PASSWORD_HASH).update();
        return new Staff(id, store, username);
    }

    private void enroll(Staff staff) {
        byte[] encrypted = new OperatorTotp(FIXTURE_KEY).encryptSecret(staff.id(), SEED);
        jdbc.sql("UPDATE operator_accounts SET mfa_encrypted_secret = ? WHERE id = ?")
            .params(encrypted, staff.id()).update();
    }

    private AccountState accountState(Staff staff) {
        return jdbc.sql("SELECT failed_logins, mfa_last_counter FROM operator_accounts WHERE id = ?").param(staff.id())
            .query((rows, number) -> new AccountState(rows.getInt("failed_logins"),
                    rows.getObject("mfa_last_counter", Long.class))).single();
    }

    private long sessionCount(Staff staff, boolean mfa) {
        return jdbc.sql("SELECT count(*) FROM operator_sessions WHERE operator_id = ? AND mfa_verified = ?")
            .params(staff.id(), mfa).query(Long.class).single();
    }

    private long currentCounter() {
        return jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single().toEpochSecond() / 30;
    }

    private static String codeAt(long counter) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA1");
        mac.init(new SecretKeySpec(SEED, "HmacSHA1"));
        byte[] hash = mac.doFinal(ByteBuffer.allocate(Long.BYTES).putLong(counter).array());
        int offset = hash[hash.length - 1] & 0x0f;
        int value = ByteBuffer.wrap(hash, offset, Integer.BYTES).getInt() & Integer.MAX_VALUE;
        return String.format(Locale.ROOT, "%06d", value % 1_000_000);
    }

    private ResultActions login(Staff staff, String password, String code) throws Exception {
        return api.perform(post(ROOT + "/sessions").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new Login(staff.username(), password, code))));
    }

    private ResultActions queue(String bearer) throws Exception {
        return api.perform(get(ROOT + "/orders").header(HttpHeaders.AUTHORIZATION, bearer));
    }

    private String bearer(ResultActions result) throws Exception {
        byte[] body = result.andReturn().getResponse().getContentAsByteArray();
        return "Bearer " + json.readTree(body).path("accessToken").asString();
    }

    private record Staff(UUID id, String store, String username) {}
    private record AccountState(int failures, Long counter) {}
}
