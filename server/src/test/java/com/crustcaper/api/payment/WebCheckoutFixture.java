package com.crustcaper.api.payment;

import com.crustcaper.api.CrustCaperApplication;
import com.crustcaper.api.recovery.PhoneVerificationGateway;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.boot.SpringApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import tools.jackson.databind.ObjectMapper;

/** Entry point loaded explicitly from test classes by the isolated storefront stack. */
public final class WebCheckoutFixture {
    private static final String WEB_ORIGIN = "https://crustcaper.test";
    private static final String FIXTURE_KEY = "fixture-only";
    private static final String FIXTURE_DATABASE_URL = "jdbc:postgresql://postgres:5432/storefront_fixture";
    private static final String FIXTURE_DATABASE_USER = "storefront_fixture";
    private static final String RESTART_WEBHOOK_SECRET = "fixture-restart-webhook-v1";
    private static final String RETURN_URL = WEB_ORIGIN + "/payment-return";
    private static final int PROVIDER_PORT = 18432;

    private WebCheckoutFixture() {}

    public static void main(String[] args) throws IOException {
        if (args.length == 1 && "--provider".equals(args[0])) {
            if (!"1".equals(System.getenv("CRUSTCAPER_STOREFRONT_RESTART_PROVIDER"))) throw wrongFixture();
            var provider = new Provider(new ObjectMapper(), true);
            Runtime.getRuntime().addShutdownHook(new Thread(provider::close, "fixture-provider-shutdown"));
            return;
        }

        boolean restartApi = args.length == 1 && "--restart-api".equals(args[0]);
        if ((args.length != 0 && !restartApi)
            || !"stage".equals(System.getenv("SPRING_PROFILES_ACTIVE"))
            || !(restartApi ? "flutterwave" : "fixture").equals(System.getenv("CRUSTCAPER_PAYMENT_PROVIDER"))
            || !"disabled".equals(System.getenv("CRUSTCAPER_ORDER_ACCESS_PROVIDER"))
            || !WEB_ORIGIN.equals(System.getenv("CRUSTCAPER_WEB_ORIGIN"))
            || !FIXTURE_DATABASE_URL.equals(System.getenv("CRUSTCAPER_DB_URL"))
            || !FIXTURE_DATABASE_USER.equals(System.getenv("CRUSTCAPER_DB_USER"))) {
            throw wrongFixture();
        }
        if (restartApi && (System.getenv("FLUTTERWAVE_SECRET_KEY") != null
            || !RESTART_WEBHOOK_SECRET.equals(System.getenv("FLUTTERWAVE_WEBHOOK_SECRET"))
            || !RETURN_URL.equals(System.getenv("CRUST_PAYMENT_RETURN_URL")))) {
            throw wrongFixture();
        }
        new SpringApplication(CrustCaperApplication.class, FixturePhoneBeans.class,
            restartApi ? RestartApiBeans.class : FixtureBeans.class).run();
    }

    private static IllegalStateException wrongFixture() {
        return new IllegalStateException("WebCheckoutFixture requires the isolated storefront test stack");
    }

    // The explicit Spring source registers these beans without making them discoverable by component scans.
    static class FixturePhoneBeans {
        @Bean
        PhoneVerificationGateway fixturePhoneVerification() {
            return new PhoneVerificationGateway() {
                private final Set<String> sent = ConcurrentHashMap.newKeySet();

                @Override
                public String send(String phone) {
                    String reference = "VE" + UUID.randomUUID().toString().replace("-", "");
                    sent.add(reference);
                    return reference;
                }

                @Override
                public VerificationCheck check(String reference, String code) {
                    return sent.contains(reference) && "418263".equals(code)
                        ? VerificationCheck.APPROVED : VerificationCheck.INVALID;
                }
            };
        }
    }

    static class FixtureBeans {
        @Bean
        FlutterwavePaymentGateway fixtureGateway(ObjectMapper mapper, Provider provider) {
            return new FlutterwavePaymentGateway(URI.create("http://127.0.0.1:" + provider.port()),
                URI.create(RETURN_URL), URI.create(WEB_ORIGIN + "/web-payment-return"),
                FIXTURE_KEY, mapper, Clock.systemUTC(), 2000, 2000);
        }

        @Bean(destroyMethod = "close")
        Provider fixtureProvider(ObjectMapper mapper) throws IOException {
            return new Provider(mapper, false);
        }
    }

    static class RestartApiBeans {
        @Bean
        static BeanFactoryPostProcessor removeConfiguredFlutterwaveGateway(Environment environment) {
            return factory -> {
                if (!(factory instanceof BeanDefinitionRegistry registry)
                    || !Arrays.equals(environment.getActiveProfiles(), new String[] {"stage"})
                    || !FIXTURE_DATABASE_URL.equals(environment.getProperty("spring.datasource.url"))
                    || !FIXTURE_DATABASE_USER.equals(environment.getProperty("spring.datasource.username"))
                    || !WEB_ORIGIN.equals(environment.getProperty("crustcaper.web.origin"))
                    || !"disabled".equals(environment.getProperty("crustcaper.order-access.provider", "disabled"))
                    || !registry.containsBeanDefinition("flutterwaveGateway")
                    || !registry.containsBeanDefinition("paymentReconciliation")) {
                    throw wrongFixture();
                }
                // Retain production reconciliation and its scheduler while eliminating the real PSP endpoint.
                registry.removeBeanDefinition("flutterwaveGateway");
            };
        }

        @Bean
        FlutterwavePaymentGateway fixtureRestartGateway(ObjectMapper mapper) {
            return new FlutterwavePaymentGateway(URI.create("http://provider:" + PROVIDER_PORT),
                URI.create(RETURN_URL), URI.create(WEB_ORIGIN + "/web-payment-return"),
                FIXTURE_KEY, mapper, Clock.systemUTC(), 2_000, 20_000);
        }
    }

    private record Charge(String returnUrl, long amount, long transactionId, AtomicBoolean paid) {}

    static final class Provider implements AutoCloseable {
        private static final String HOSTED_PATH = "/v3/hosted/pay/";
        private static final String STATE_PATH = "/fixture/state";
        private static final Pattern UUID_PATH = Pattern.compile("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}");
        private static final Pattern RETURN_URL = Pattern.compile(Pattern.quote(WEB_ORIGIN)
            + "/(?:web-)?payment-return\\?orderId=" + UUID_PATH.pattern());
        private static final int MAX_CHECKOUT_BODY = 16 * 1024;
        private static final Duration VERIFY_HOLD = Duration.ofSeconds(15);
        private final ObjectMapper mapper;
        private final HttpServer server;
        private final ExecutorService workers;
        private final Map<String, Charge> charges = new ConcurrentHashMap<>();
        private final AtomicLong sequences = new AtomicLong(7000);
        private final AtomicLong openCalls = new AtomicLong();
        private final AtomicLong verifyCalls = new AtomicLong();
        private final AtomicBoolean firstPaidVerificationStarted = new AtomicBoolean();
        private final AtomicBoolean firstPaidVerificationHeld = new AtomicBoolean();

        Provider(ObjectMapper mapper, boolean restart) throws IOException {
            this.mapper = mapper;
            server = HttpServer.create(new InetSocketAddress("0.0.0.0", PROVIDER_PORT), 0);
            workers = restart ? Executors.newFixedThreadPool(4,
                Thread.ofPlatform().name("fixture-provider-", 0).factory()) : null;
            server.createContext("/v3/payments", this::open);
            server.createContext("/v3/transactions/verify_by_reference", this::verify);
            server.createContext(HOSTED_PATH, this::hosted);
            if (workers != null) {
                server.setExecutor(workers);
                server.createContext(STATE_PATH, this::state);
            }
            server.start();
        }

        int port() {
            return server.getAddress().getPort();
        }

        private void open(HttpExchange exchange) throws IOException {
            try (exchange) {
                if (!"POST".equals(exchange.getRequestMethod()) || !authorized(exchange)) {
                    reply(exchange, 400, "", "text/plain");
                    return;
                }
                openCalls.incrementAndGet();
                byte[] body = exchange.getRequestBody().readNBytes(MAX_CHECKOUT_BODY + 1);
                if (body.length > MAX_CHECKOUT_BODY) {
                    reply(exchange, 413, "", "text/plain");
                    return;
                }
                var input = mapper.readTree(body);
                String reference = input.path("tx_ref").asString();
                String destination = input.path("redirect_url").asString();
                long amount = input.path("amount").asLong();
                if (!UUID_PATH.matcher(reference).matches() || !RETURN_URL.matcher(destination).matches()
                    || amount <= 0 || !"RWF".equals(input.path("currency").asString())) {
                    reply(exchange, 400, "", "text/plain");
                    return;
                }
                var charge = new Charge(destination, amount, sequences.incrementAndGet(), new AtomicBoolean());
                if (charges.putIfAbsent(reference, charge) != null) {
                    reply(exchange, 409, "", "text/plain");
                    return;
                }
                var link = Map.of("link", "https://checkout.flutterwave.com" + HOSTED_PATH + reference);
                reply(exchange, 200, mapper.writeValueAsString(Map.of("status", "success", "data", link)), "application/json");
            }
        }

        private void verify(HttpExchange exchange) throws IOException {
            try (exchange) {
                if (!"GET".equals(exchange.getRequestMethod()) || !authorized(exchange)) {
                    reply(exchange, 400, "", "text/plain");
                    return;
                }
                verifyCalls.incrementAndGet();
                String query = exchange.getRequestURI().getRawQuery();
                String reference = query != null && query.startsWith("tx_ref=") ? query.substring(7) : "";
                Charge charge = charges.get(reference);
                if (charge == null || !charge.paid().get()) {
                    reply(exchange, 404, "{}", "application/json");
                    return;
                }
                if (workers != null && firstPaidVerificationStarted.compareAndSet(false, true)) {
                    firstPaidVerificationHeld.set(true);
                    try {
                        Thread.sleep(VERIFY_HOLD);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    } finally {
                        firstPaidVerificationHeld.set(false);
                    }
                }
                var payment = Map.of("id", charge.transactionId(), "tx_ref", reference, "amount", charge.amount(),
                    "charged_amount", charge.amount(), "currency", "RWF", "status", "successful");
                reply(exchange, 200, mapper.writeValueAsString(Map.of("status", "success", "data", payment)), "application/json");
            }
        }

        private void state(HttpExchange exchange) throws IOException {
            try (exchange) {
                if (!"GET".equals(exchange.getRequestMethod()) || !STATE_PATH.equals(exchange.getRequestURI().getRawPath())
                    || exchange.getRequestURI().getRawQuery() != null) {
                    reply(exchange, 404, "", "text/plain");
                    return;
                }
                reply(exchange, 200, mapper.writeValueAsString(Map.of(
                    "openCalls", openCalls.get(),
                    "paidCharges", charges.values().stream().filter(charge -> charge.paid().get()).count(),
                    "verifyCalls", verifyCalls.get(),
                    "firstPaidVerificationHeld", firstPaidVerificationHeld.get())), "application/json");
            }
        }

        private void hosted(HttpExchange exchange) throws IOException {
            try (exchange) {
                String reference = exchange.getRequestURI().getPath().substring(HOSTED_PATH.length());
                Charge charge = charges.get(reference);
                if (charge == null) {
                    reply(exchange, 404, "", "text/plain");
                    return;
                }
                if ("POST".equals(exchange.getRequestMethod())) {
                    String result = new String(exchange.getRequestBody().readNBytes(32), StandardCharsets.UTF_8);
                    if ("result=pay".equals(result)) {
                        charge.paid().set(true);
                    } else if (!"result=back".equals(result)) {
                        reply(exchange, 400, "", "text/plain");
                        return;
                    }
                    // Both returns claim success. Only the verification endpoint confirms settlement.
                    exchange.getResponseHeaders().set("Location", charge.returnUrl() + "&status=successful&transaction_id=1");
                    reply(exchange, 303, "", "text/plain");
                    return;
                }
                if (!"GET".equals(exchange.getRequestMethod())) {
                    reply(exchange, 405, "", "text/plain");
                    return;
                }
                reply(exchange, 200, """
                    <!doctype html><html lang="en"><title>Isolated checkout</title>
                    <h1>Isolated checkout</h1><form method="post">
                    <button name="result" value="back">Return without settlement</button>
                    <button name="result" value="pay">Settle fixture payment</button></form></html>
                    """, "text/html; charset=utf-8");
            }
        }

        private static boolean authorized(HttpExchange exchange) {
            return ("Bearer " + FIXTURE_KEY).equals(exchange.getRequestHeaders().getFirst("Authorization"));
        }

        private static void reply(HttpExchange exchange, int status, String body, String type) throws IOException {
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", type);
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(status, payload.length == 0 ? -1 : payload.length);
            if (payload.length != 0) exchange.getResponseBody().write(payload);
        }

        @Override
        public void close() {
            server.stop(0);
            if (workers != null) workers.shutdownNow();
        }
    }
}
