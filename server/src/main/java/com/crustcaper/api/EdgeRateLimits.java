package com.crustcaper.api;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration(proxyBeanMethods = false)
class EdgeRateLimits implements WebMvcConfigurer, HandlerInterceptor {
    static final String CLIENT_IP = "X-CrustCaper-Client-IP";
    static final String EDGE_PROOF = "X-CrustCaper-Edge-Proof";
    static final String ORDER_ADMISSION = "crustcaper.edge.order-admission";
    private static final String ADMITTED_ROUTE = "crustcaper.edge.admitted-route";
    private static final int WINDOW_SECONDS = 60;
    private static final int MAX_NETWORKS = 4096;
    private static final String HMAC = "HmacSHA256";

    enum Category { SESSION, OTP_START, OTP_VERIFY, STAFF_LOGIN, QUOTE, ORDER }

    private static final Map<String, Category> ROUTES = Map.ofEntries(
        Map.entry("/api/v1/guest-sessions", Category.SESSION),
        Map.entry("/api/v1/guest-sessions/refresh", Category.SESSION),
        Map.entry("/api/v1/web/session", Category.SESSION),
        Map.entry("/api/v1/order-access/challenges", Category.OTP_START),
        Map.entry("/api/v1/web/order-access/challenges", Category.OTP_START),
        Map.entry("/api/v1/checkout-recovery", Category.OTP_START),
        Map.entry("/api/v1/web/checkout-recovery", Category.OTP_START),
        Map.entry("/api/v1/order-access/challenges/{id}/verify", Category.OTP_VERIFY),
        Map.entry("/api/v1/web/order-access/challenges/{id}/verify", Category.OTP_VERIFY),
        Map.entry("/api/v1/operator/sessions", Category.STAFF_LOGIN),
        Map.entry("/api/v1/quotes", Category.QUOTE),
        Map.entry("/api/v1/web/quotes", Category.QUOTE),
        Map.entry("/api/v1/orders", Category.ORDER),
        Map.entry("/api/v1/web/orders", Category.ORDER)
    );

    private final boolean enabled;
    private final byte[] proof;
    private final SecretKeySpec key;
    private final Map<Category, Integer> limits;
    private final int maximumNetworks;
    private final LongSupplier seconds;
    private final Map<String, int[]> counters = new HashMap<>();
    private long window = -1;

    @Autowired
    EdgeRateLimits(@Value("${crustcaper.edge-rate.enabled}") boolean enabled,
                   @Value("${crustcaper.edge-rate.proof}") String proof,
                   @Value("${crustcaper.edge-rate.sessions-per-minute}") int sessions,
                   @Value("${crustcaper.edge-rate.otp-starts-per-minute}") int otpStarts,
                   @Value("${crustcaper.edge-rate.otp-verifications-per-minute}") int otpVerifications,
                   @Value("${crustcaper.edge-rate.staff-logins-per-minute}") int staffLogins,
                   @Value("${crustcaper.edge-rate.quotes-per-minute}") int quotes,
                   @Value("${crustcaper.edge-rate.orders-per-minute}") int orders) {
        this(enabled, proof, Map.of(Category.SESSION, sessions, Category.OTP_START, otpStarts,
            Category.OTP_VERIFY, otpVerifications, Category.STAFF_LOGIN, staffLogins,
            Category.QUOTE, quotes, Category.ORDER, orders), MAX_NETWORKS, monotonicSeconds());
    }

    EdgeRateLimits(boolean enabled, String proof, Map<Category, Integer> limits, int maximumNetworks,
                   LongSupplier seconds) {
        if (enabled && !proof.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Set CRUSTCAPER_EDGE_RATE_PROOF to 64 lowercase hexadecimal characters");
        }
        if (maximumNetworks < 1 || Arrays.stream(Category.values()).anyMatch(category -> limits.getOrDefault(category, 0) < 1)) {
            throw new IllegalArgumentException("Edge rate limits must be positive");
        }
        this.enabled = enabled;
        this.proof = enabled ? HexFormat.of().parseHex(proof) : new byte[0];
        this.key = enabled ? new SecretKeySpec(new SecureRandom().generateSeed(32), HMAC) : null;
        this.limits = Map.copyOf(limits);
        this.maximumNetworks = maximumNetworks;
        this.seconds = seconds;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        if (enabled) {
            registry.addInterceptor(this).addPathPatterns(ROUTES.keySet().toArray(String[]::new)).order(10);
        }
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!enabled || !request.getMethod().equals("POST")) return true;
        Object route = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        Category category = route == null ? null : ROUTES.get(route.toString());
        if (category == null) return true;
        // Async dispatch delivers the result of this request, including a completed OTP verification.
        if (request.getDispatcherType() == DispatcherType.ASYNC
            && route.toString().equals(request.getAttribute(ADMITTED_ROUTE))) return true;
        String submittedProof = singleHeader(request, EDGE_PROOF);
        if (submittedProof == null || !submittedProof.matches("[0-9a-f]{64}")
            || !MessageDigest.isEqual(proof, HexFormat.of().parseHex(submittedProof))) {
            throw ApiFailure.forbidden();
        }
        String network = pseudonym(networkPrefix(singleHeader(request, CLIENT_IP)));
        if (category == Category.ORDER) {
            // Only a new order consumes this budget. OrderService handles replays first.
            request.setAttribute(ORDER_ADMISSION, (Runnable) () -> admit(Category.ORDER, network));
        } else {
            admit(category, network);
        }
        request.setAttribute(ADMITTED_ROUTE, route.toString());
        return true;
    }

    private synchronized void admit(Category category, String network) {
        long now = seconds.getAsLong();
        rotateWindow(now / WINDOW_SECONDS);
        int retryAfter = WINDOW_SECONDS - (int) (now % WINDOW_SECONDS);
        int[] usage = counters.get(network);
        if (usage == null) {
            // Do not evict a current bucket and thereby reset its network's budget.
            if (counters.size() >= maximumNetworks) throw ApiFailure.rateLimited(retryAfter);
            usage = new int[Category.values().length];
            counters.put(network, usage);
        }
        int index = category.ordinal();
        if (usage[index] >= limits.get(category)) throw ApiFailure.rateLimited(retryAfter);
        usage[index]++;
    }

    @Scheduled(fixedRateString = "PT1M")
    synchronized void removeExpiredCounters() {
        if (enabled) rotateWindow(seconds.getAsLong() / WINDOW_SECONDS);
    }

    private void rotateWindow(long current) {
        if (window != current) {
            counters.clear();
            window = current;
        }
    }

    private static String singleHeader(HttpServletRequest request, String name) {
        var values = request.getHeaders(name);
        if (!values.hasMoreElements()) return null;
        String value = values.nextElement();
        return values.hasMoreElements() ? null : value;
    }

    private static byte[] networkPrefix(String literal) {
        if (literal == null || literal.length() > 45) throw ApiFailure.forbidden();
        if (literal.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")) {
            String[] octets = literal.split("\\.");
            byte[] address = new byte[4];
            for (int i = 0; i < address.length; i++) {
                int octet = Integer.parseInt(octets[i]);
                if (octet > 255) throw ApiFailure.forbidden();
                address[i] = (byte) octet;
            }
            return address;
        }
        if (!literal.contains(":") || !literal.matches("[0-9a-fA-F:.]+")) throw ApiFailure.forbidden();
        try {
            // URI verifies the bracketed IPv6 literal before InetAddress handles it without DNS.
            URI.create("http://[" + literal + "]");
            byte[] address = InetAddress.getByName(literal).getAddress();
            return address.length == 4 ? address : Arrays.copyOf(address, 8);
        } catch (IllegalArgumentException | UnknownHostException invalid) {
            throw ApiFailure.forbidden();
        }
    }

    private String pseudonym(byte[] network) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(key);
            return HexFormat.of().formatHex(mac.doFinal(network));
        } catch (GeneralSecurityException unavailable) {
            throw new IllegalStateException("Unable to identify the network bucket", unavailable);
        }
    }

    private static LongSupplier monotonicSeconds() {
        long startup = System.nanoTime();
        return () -> TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - startup);
    }
}
