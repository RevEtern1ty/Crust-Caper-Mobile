package com.crustcaper.api.push;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodySubscriber;
import java.net.http.HttpResponse.BodySubscribers;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
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
import tools.jackson.databind.node.MissingNode;

final class ExpoPushHttpTransport implements ExpoPushTransport, AutoCloseable {
    private static final URI API_ORIGIN = URI.create("https://exp.host");
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);
    private static final Duration DEADLINE = Duration.ofSeconds(6);
    private static final int MAX_RESPONSE_BYTES = 32 * 1024;
    private static final Pattern ERROR_CODE = Pattern.compile("[A-Za-z0-9_]{1,64}");

    private final URI sendEndpoint;
    private final URI receiptEndpoint;
    private final Duration deadline;
    private final HttpClient client;
    private final String authorization;
    private final ObjectMapper mapper;
    private final ObjectReader jsonReader;

    ExpoPushHttpTransport(ObjectMapper mapper, String accessToken) {
        this(API_ORIGIN, DEADLINE, mapper, accessToken);
    }

    ExpoPushHttpTransport(URI origin, Duration deadline, ObjectMapper mapper, String accessToken) {
        if (!API_ORIGIN.equals(origin) && !("http".equals(origin.getScheme()) && "127.0.0.1".equals(origin.getHost())
                && origin.getPort() > 0 && origin.getRawUserInfo() == null && origin.getRawQuery() == null
                && origin.getRawFragment() == null && origin.getRawPath().isEmpty())) {
            throw new IllegalArgumentException("Push provider origin must be Expo HTTPS or a loopback test fixture");
        }
        if (accessToken == null || !accessToken.matches("[!-~]{16,512}")) {
            throw new IllegalStateException("Set a valid CRUSTCAPER_EXPO_PUSH_ACCESS_TOKEN");
        }
        this.sendEndpoint = origin.resolve("/--/api/v2/push/send");
        this.receiptEndpoint = origin.resolve("/--/api/v2/push/getReceipts");
        this.deadline = deadline;
        this.mapper = mapper;
        this.jsonReader = mapper.readerFor(JsonNode.class).with(
                DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
        this.authorization = "Bearer " + accessToken;
        this.client = HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    @Override
    public SendResult send(ReadyAlert alert) {
        if (!PickupPushCipher.validToken(alert.token())) {
            return SendResult.of(SendStatus.INVALID_TOKEN);
        }
        boolean rw = "rw".equals(alert.locale());
        Map<String, Object> message = Map.of(
                "to", alert.token(),
                "title", rw ? "Komande yawe iriteguye" : "Your order is ready",
                "body", rw ? "Fungura CrustCaper urebe amakuru yo kuyifata." : "Open CrustCaper for pickup details.",
                "channelId", PICKUP_READY,
                "expiration", alert.expiresAt().getEpochSecond(),
                "data", Map.of("type", PICKUP_READY, "orderId", alert.orderId().toString()));
        Optional<Response> attempted = post(sendEndpoint, List.of(message));
        if (attempted.isEmpty()) {
            return SendResult.of(SendStatus.AMBIGUOUS);
        }
        Response response = attempted.orElseThrow();
        if (response.status() != 200) {
            return requestFailure(response);
        }
        JsonNode data = successfulData(response.json());
        if (!data.isArray() || data.size() != 1) {
            return SendResult.of(SendStatus.AMBIGUOUS);
        }
        JsonNode ticket = data.get(0);
        String status = text(ticket.path("status"));
        String id = text(ticket.path("id"));
        JsonNode code = ticket.path("details").path("error");
        if ("ok".equals(status) && TICKET_ID.matcher(id).matches() && code.isMissingNode()) {
            return new SendResult(SendStatus.ACCEPTED, id);
        }
        if (!"error".equals(status) || !ticket.path("id").isMissingNode() || !ERROR_CODE.matcher(text(code)).matches()) {
            return SendResult.of(SendStatus.AMBIGUOUS);
        }
        return SendResult.of(switch (code.stringValue()) {
            case "DeviceNotRegistered" -> SendStatus.INVALID_TOKEN;
            case "MessageRateExceeded" -> SendStatus.THROTTLED;
            default -> SendStatus.REJECTED;
        });
    }

    @Override
    public ReceiptStatus receipt(String ticketId) {
        if (ticketId == null || !TICKET_ID.matcher(ticketId).matches()) {
            return ReceiptStatus.REJECTED;
        }
        Optional<Response> result = post(receiptEndpoint, Map.of("ids", List.of(ticketId)));
        if (result.isEmpty() || result.orElseThrow().status() != 200) {
            return ReceiptStatus.UNAVAILABLE;
        }
        JsonNode receipts = successfulData(result.orElseThrow().json());
        if (!receipts.isObject()) {
            return ReceiptStatus.UNAVAILABLE;
        }
        if (receipts.isEmpty()) {
            return ReceiptStatus.PENDING;
        }
        JsonNode receipt = receipts.path(ticketId);
        if (receipts.size() != 1 || !receipt.isObject()) {
            return ReceiptStatus.UNAVAILABLE;
        }
        String status = text(receipt.path("status"));
        JsonNode code = receipt.path("details").path("error");
        if ("ok".equals(status) && code.isMissingNode()) {
            return ReceiptStatus.HANDED_OFF;
        }
        if ("error".equals(status) && ERROR_CODE.matcher(text(code)).matches()) {
            return "DeviceNotRegistered".equals(code.stringValue()) ? ReceiptStatus.INVALID_TOKEN : ReceiptStatus.REJECTED;
        }
        return ReceiptStatus.UNAVAILABLE;
    }

    @Override
    public void close() {
        client.shutdownNow();
    }

    private static SendResult requestFailure(Response response) {
        JsonNode errors = response.json().path("errors");
        if (!errors.isArray() || errors.size() != 1 || !response.json().path("data").isMissingNode()) {
            return SendResult.of(SendStatus.AMBIGUOUS);
        }
        String code = text(errors.get(0).path("code"));
        if (response.status() == 429 && "TOO_MANY_REQUESTS".equals(code)) {
            // An explicit request rejection is safe to reschedule. A lost or ambiguous response is not.
            return SendResult.of(SendStatus.THROTTLED);
        }
        return SendResult.of(ERROR_CODE.matcher(code).matches() && response.status() >= 400 && response.status() < 500
                && response.status() != 408 && response.status() != 429
                ? SendStatus.REJECTED : SendStatus.AMBIGUOUS);
    }

    private static JsonNode successfulData(JsonNode json) {
        JsonNode errors = json.path("errors");
        return errors.isMissingNode() || (errors.isArray() && errors.isEmpty()) ? json.path("data") : MissingNode.getInstance();
    }

    private Optional<Response> post(URI uri, Object body) {
        CompletableFuture<HttpResponse<byte[]>> future;
        try {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(deadline)
                    .header("Authorization", authorization).header("Accept", "application/json")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(body))).build();
            future = client.sendAsync(request, ignored -> new BoundedBody());
        } catch (JacksonException ignored) {
            return Optional.empty();
        }
        try {
            HttpResponse<byte[]> response = future.get(deadline.toMillis(), TimeUnit.MILLISECONDS);
            JsonNode json = jsonReader.readValue(response.body());
            return json != null && json.isObject() ? Optional.of(new Response(response.statusCode(), json)) : Optional.empty();
        } catch (InterruptedException ignored) {
            future.cancel(true);
            Thread.currentThread().interrupt();
        } catch (ExecutionException | TimeoutException | JacksonException ignored) {
            future.cancel(true);
        }
        // Provider errors can include the recipient token. Do not attach them to the outcome or logs.
        return Optional.empty();
    }

    private static String text(JsonNode node) {
        return node.isString() ? node.stringValue() : "";
    }

    private record Response(int status, JsonNode json) { }

    private static final class BoundedBody implements BodySubscriber<byte[]> {
        private final BodySubscriber<byte[]> body = BodySubscribers.ofByteArray();
        private Flow.Subscription subscription;
        private long bytes;

        @Override public CompletionStage<byte[]> getBody() { return body.getBody(); }

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            body.onSubscribe(subscription);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) bytes += buffer.remaining();
            if (bytes > MAX_RESPONSE_BYTES) {
                subscription.cancel();
                body.onError(new IOException("Oversized Expo push response"));
                return;
            }
            body.onNext(buffers);
        }

        @Override public void onError(Throwable error) { body.onError(error); }
        @Override public void onComplete() { body.onComplete(); }
    }
}
