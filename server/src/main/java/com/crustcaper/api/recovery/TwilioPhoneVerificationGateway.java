package com.crustcaper.api.recovery;

import static com.crustcaper.api.recovery.PhoneVerificationException.Kind.RETRY_LATER;
import static com.crustcaper.api.recovery.PhoneVerificationException.Kind.UNAVAILABLE;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodySubscriber;
import java.net.http.HttpResponse.BodySubscribers;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;

final class TwilioPhoneVerificationGateway implements PhoneVerificationGateway, AutoCloseable {
    private static final URI API_ORIGIN = URI.create("https://verify.twilio.com");
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);
    private static final Duration REQUEST_DEADLINE = Duration.ofSeconds(6);
    private static final Pattern SERVICE_SID = Pattern.compile("VA[0-9a-fA-F]{32}");
    private static final Pattern API_KEY_SID = Pattern.compile("SK[0-9a-fA-F]{32}");
    private static final Pattern API_KEY_SECRET = Pattern.compile("[!-~]{24,256}");
    private static final Pattern VERIFICATION_SID = Pattern.compile("VE[0-9a-fA-F]{32}");
    private static final Pattern E164 = Pattern.compile("\\+[1-9][0-9]{6,14}");
    private static final Pattern SIX_DIGITS = Pattern.compile("[0-9]{6}");
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private static final int MAX_CHECK_ATTEMPTS_ERROR = 60202;

    private final URI startUri;
    private final URI checkUri;
    private final String serviceSid;
    private final String authorization;
    private final Duration deadline;
    private final HttpClient client;
    private final ObjectReader responseReader;

    TwilioPhoneVerificationGateway(ObjectMapper mapper, String serviceSid, String keySid, String keySecret) {
        this(API_ORIGIN, REQUEST_DEADLINE, mapper, serviceSid, keySid, keySecret);
    }

    TwilioPhoneVerificationGateway(URI origin, Duration deadline, ObjectMapper mapper,
                                  String serviceSid, String keySid, String keySecret) {
        requireSetting(SERVICE_SID, serviceSid, "CRUSTCAPER_TWILIO_VERIFY_SERVICE_SID");
        requireSetting(API_KEY_SID, keySid, "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SID");
        requireSetting(API_KEY_SECRET, keySecret, "CRUSTCAPER_TWILIO_VERIFY_API_KEY_SECRET");
        this.serviceSid = serviceSid;
        this.deadline = deadline;
        this.authorization = "Basic " + Base64.getEncoder()
                .encodeToString((keySid + ":" + keySecret).getBytes(StandardCharsets.US_ASCII));
        String servicePath = "/v2/Services/" + serviceSid + "/";
        this.startUri = origin.resolve(servicePath + "Verifications");
        this.checkUri = origin.resolve(servicePath + "VerificationCheck");
        this.client = HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        this.responseReader = mapper.readerFor(JsonNode.class).with(
                DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    @Override
    public String send(String phone) {
        if (!matches(E164, phone)) {
            throw new PhoneVerificationException(UNAVAILABLE);
        }
        HttpResponse<byte[]> response = post(startUri, "To=" + encode(phone) + "&Channel=sms");
        JsonNode json = verification(response);
        String sid = text(json, "sid");
        if (!matches(VERIFICATION_SID, sid) || !phone.equals(text(json, "to")) || !"pending".equals(text(json, "status"))) {
            throw new PhoneVerificationException(UNAVAILABLE);
        }
        return sid;
    }

    @Override
    public VerificationCheck check(String verificationSid, String code) {
        if (!matches(VERIFICATION_SID, verificationSid)) {
            return VerificationCheck.EXPIRED;
        }
        if (!matches(SIX_DIGITS, code)) {
            return VerificationCheck.INVALID;
        }
        HttpResponse<byte[]> response = post(checkUri, "VerificationSid=" + encode(verificationSid) + "&Code=" + encode(code));
        if (response.statusCode() == 404 || maxCheckAttemptsReached(response)) {
            return VerificationCheck.EXPIRED;
        }
        JsonNode json = verification(response);
        if (!verificationSid.equals(text(json, "sid"))) {
            throw new PhoneVerificationException(UNAVAILABLE);
        }
        return switch (text(json, "status")) {
            case "approved" -> VerificationCheck.APPROVED;
            case "pending" -> VerificationCheck.INVALID;
            case "canceled", "max_attempts_reached", "deleted", "failed", "expired" -> VerificationCheck.EXPIRED;
            default -> throw new PhoneVerificationException(UNAVAILABLE);
        };
    }

    @Override
    public void close() {
        client.shutdownNow();
    }

    private HttpResponse<byte[]> post(URI uri, String form) {
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(deadline)
                .header("Authorization", authorization)
                .header("Accept", "application/json")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        CompletableFuture<HttpResponse<byte[]>> response = client.sendAsync(request, ignored -> new BoundedBody());
        try {
            return response.get(deadline.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
            response.cancel(true);
            Thread.currentThread().interrupt();
            throw new PhoneVerificationException(UNAVAILABLE);
        } catch (ExecutionException | TimeoutException ignored) {
            response.cancel(true);
            // A timeout can follow a real send or approval. Never retry it here or attach a provider error body.
            throw new PhoneVerificationException(UNAVAILABLE);
        }
    }

    private JsonNode verification(HttpResponse<byte[]> response) {
        int status = response.statusCode();
        if (status == 429) {
            throw new PhoneVerificationException(RETRY_LATER);
        }
        if (status < 200 || status >= 300) {
            throw new PhoneVerificationException(UNAVAILABLE);
        }
        JsonNode json = json(response.body());
        if (!serviceSid.equals(text(json, "service_sid")) || !"sms".equals(text(json, "channel"))) {
            throw new PhoneVerificationException(UNAVAILABLE);
        }
        return json;
    }

    private boolean maxCheckAttemptsReached(HttpResponse<byte[]> response) {
        if (response.statusCode() != 429) {
            return false;
        }
        try {
            JsonNode code = json(response.body()).path("code");
            return code.isIntegralNumber() && code.asLong() == MAX_CHECK_ATTEMPTS_ERROR;
        } catch (PhoneVerificationException ignored) {
            return false;
        }
    }

    private JsonNode json(byte[] body) {
        try {
            JsonNode json = responseReader.readValue(body);
            if (json != null && json.isObject()) {
                return json;
            }
        } catch (JacksonException ignored) {
            // Redact provider challenges, contacts and credentials in malformed payloads.
        }
        throw new PhoneVerificationException(UNAVAILABLE);
    }

    private static String text(JsonNode json, String field) {
        JsonNode value = json.path(field);
        return value.isString() ? value.stringValue() : "";
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static boolean matches(Pattern pattern, String value) {
        return value != null && pattern.matcher(value).matches();
    }

    private static void requireSetting(Pattern pattern, String value, String name) {
        if (!matches(pattern, value)) {
            throw new IllegalStateException("Set a valid " + name);
        }
    }

    private static final class BoundedBody implements BodySubscriber<byte[]> {
        private final BodySubscriber<byte[]> body = BodySubscribers.ofByteArray();
        private Flow.Subscription subscription;
        private long received;

        @Override
        public CompletionStage<byte[]> getBody() {
            return body.getBody();
        }

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            body.onSubscribe(subscription);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                received += buffer.remaining();
            }
            if (received > MAX_RESPONSE_BYTES) {
                subscription.cancel();
                body.onError(new IOException("Oversized phone verification response"));
                return;
            }
            body.onNext(buffers);
        }

        @Override
        public void onError(Throwable error) {
            body.onError(error);
        }

        @Override
        public void onComplete() {
            body.onComplete();
        }
    }
}
