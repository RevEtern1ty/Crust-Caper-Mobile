package com.crustcaper.api.payment;

import static com.crustcaper.api.payment.PaymentGatewayException.Kind.INVALID_REQUEST;
import static com.crustcaper.api.payment.PaymentGatewayException.Kind.INVALID_RESPONSE;
import static com.crustcaper.api.payment.PaymentGatewayException.Kind.UNAVAILABLE;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import tools.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.HttpURLConnection;
import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

final class FlutterwavePaymentGateway implements PaymentGateway, RefundDirectory {
    static final URI API_ORIGIN = URI.create("https://api.flutterwave.com");

    private static final int MAX_RESPONSE_BYTES = 128 * 1024;
    private static final Pattern REFERENCE = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern TRANSACTION_ID = Pattern.compile("[1-9][0-9]{0,18}");
    private static final Pattern CURRENCY = Pattern.compile("[A-Z]{3}");
    private static final Pattern PHONE = Pattern.compile("\\+[1-9][0-9]{6,14}");
    private static final Pattern CHECKOUT_PATH = Pattern.compile("/v3/hosted/pay/[A-Za-z0-9_-]{1,256}");
    private static final Set<String> NOT_FOUND_MESSAGES = Set.of("transaction not found", "no transaction found");

    private final URI apiOrigin;
    private final URI returnUrl;
    private final String secretKey;
    private final ObjectMapper mapper;
    private final ObjectReader responseReader;
    private final Clock clock;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;

    FlutterwavePaymentGateway(URI apiOrigin, URI returnUrl, String secretKey, ObjectMapper mapper,
                             Clock clock, int connectTimeoutMs, int readTimeoutMs) {
        if (!isHttpsUrl(returnUrl) || returnUrl.getRawQuery() != null) {
            throw new IllegalStateException("CRUST_PAYMENT_RETURN_URL must be an absolute HTTPS URL without a query or fragment");
        }
        if (secretKey == null || !secretKey.matches("[!-~]{1,512}")) {
            throw new IllegalStateException("FLUTTERWAVE_SECRET_KEY is missing or invalid");
        }
        this.apiOrigin = apiOrigin;
        this.returnUrl = returnUrl;
        this.secretKey = secretKey;
        this.mapper = mapper;
        this.responseReader = mapper.readerFor(JsonNode.class)
                .with(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS,
                        DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
        this.clock = clock;
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
    }

    @Override
    public HostedPayment open(PaymentRequest request) {
        validateRequest(request);
        ObjectNode payload = mapper.createObjectNode()
                .put("tx_ref", request.reference())
                .put("amount", request.amount())
                .put("currency", request.currency())
                .put("redirect_url", returnUrl.toASCIIString() + "?orderId=" + request.orderId())
                .put("payment_options", "card,mobilemoneyrwanda")
                .put("link_expiration", request.expiresAt().toString());
        ObjectNode customer = payload.putObject("customer").put("email", request.email());
        if (request.phone() != null && !request.phone().isBlank()) {
            customer.put("phone_number", request.phone());
        }
        payload.putObject("customizations").put("title", "CrustCaper");
        JsonNode data = successfulData(request("/v3/payments", payload));
        String link = requiredText(data.path("link"));
        if (!isAllowedCheckoutUrl(link)) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        return new HostedPayment(link);
    }

    @Override
    public VerifiedPayment verify(String transactionId) {
        if (!matches(TRANSACTION_ID, transactionId)) {
            throw new PaymentGatewayException(INVALID_REQUEST);
        }
        VerifiedPayment verification = paymentFrom(successfulData(request("/v3/transactions/" + transactionId + "/verify", null)));
        if (!transactionId.equals(verification.transactionId())) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        return verification;
    }

    @Override
    public Optional<VerifiedPayment> verifyByReference(String reference) {
        if (!matches(REFERENCE, reference)) {
            throw new PaymentGatewayException(INVALID_REQUEST);
        }
        Response response = request("/v3/transactions/verify_by_reference?tx_ref=" + reference, null);
        if (response.status() == 404) {
            return Optional.empty();
        }
        if (response.status() == 400 && reportsMissingTransaction(response.body())) {
            return Optional.empty();
        }
        VerifiedPayment verification = paymentFrom(successfulData(response));
        if (!reference.equals(verification.reference())) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        return Optional.of(verification);
    }

    @Override
    public Optional<ConfirmedRefund> confirm(RefundRequest expected) {
        if (expected == null || !RefundDirectory.validId(expected.refundId()) || !RefundDirectory.validId(expected.transactionId())
                || !"RWF".equals(expected.currency()) || expected.amount() <= 0 || expected.amount() > MAX_CHARGE_RWF) {
            throw new PaymentGatewayException(INVALID_REQUEST);
        }
        Optional<JsonNode> details = refundResponse("/v3/refunds/" + expected.refundId());
        if (details.isEmpty()) {
            return Optional.empty();
        }
        // V3 refund detail is an unwrapped object and does not document a currency field.
        JsonNode detail = details.orElseThrow();
        String refundReference = detail.path("flw_ref").asString("");
        if (!matchesRefund(detail, expected) || !matches(REFERENCE, refundReference)) {
            return Optional.empty();
        }

        Optional<JsonNode> listings = refundResponse("/v3/refunds?currency=RWF&flw_ref=" + refundReference);
        if (listings.isEmpty()) {
            return Optional.empty();
        }
        JsonNode list = listings.orElseThrow();
        JsonNode data = list.path("data");
        if (!"success".equals(list.path("status").asString("")) || !data.isArray()) {
            return Optional.empty();
        }
        String refundStatus = detail.path("status").asString("");
        // Corroborate the same final refund in the provider's RWF-filtered directory.
        int matchingEntries = 0;
        for (JsonNode entry : data) {
            if (expected.refundId().equals(providerId(entry.path("id")))) {
                if (!matchesRefund(entry, expected) || !refundReference.equals(entry.path("flw_ref").asString(""))
                        || !refundStatus.equals(entry.path("status").asString(""))) {
                    return Optional.empty();
                }
                matchingEntries++;
            }
        }
        return matchingEntries == 1 ? Optional.of(new ConfirmedRefund(expected.refundId(), expected.transactionId(),
                expected.amount(), expected.currency(), refundStatus)) : Optional.empty();
    }

    private Optional<JsonNode> refundResponse(String path) {
        Response response = request(path, null);
        if (response.status() == 400 || response.status() == 404) {
            return Optional.empty();
        }
        if (response.status() != 200) {
            throw new PaymentGatewayException(UNAVAILABLE);
        }
        return Optional.of(readResponse(response.body()));
    }

    private static boolean matchesRefund(JsonNode refund, RefundRequest expected) {
        JsonNode currency = refund.path("currency");
        JsonNode amount = refund.path("amount_refunded");
        return expected.refundId().equals(providerId(refund.path("id")))
                && expected.transactionId().equals(providerId(refund.path("transaction_id")))
                && FINAL_STATUSES.contains(refund.path("status").asString(""))
                && (currency.isMissingNode() || expected.currency().equals(currency.asString("")))
                && amount.isNumber() && amount.decimalValue().compareTo(BigDecimal.valueOf(expected.amount())) == 0;
    }

    private static String providerId(JsonNode id) {
        return id.isIntegralNumber() || id.isString() ? id.asString("") : null;
    }

    private void validateRequest(PaymentRequest request) {
        if (request == null || !matches(REFERENCE, request.reference()) || !matches(REFERENCE, request.orderId())
                || request.amount() <= 0 || request.amount() > MAX_CHARGE_RWF || !"RWF".equals(request.currency())
                || !PaymentGateway.supportsCustomerEmail(request.email())
                || request.expiresAt() == null || !request.expiresAt().isAfter(Instant.now(clock))
                || (request.phone() != null && !request.phone().isBlank() && !matches(PHONE, request.phone()))) {
            throw new PaymentGatewayException(INVALID_REQUEST);
        }
    }

    private Response request(String path, ObjectNode payload) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) apiOrigin.resolve(path).toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestProperty("Authorization", "Bearer " + secretKey);
            connection.setRequestProperty("Accept", "application/json");
            if (payload != null) {
                byte[] requestBody = mapper.writeValueAsBytes(payload);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                // Stream the request once. A broken connection can conceal a successfully opened payment.
                connection.setFixedLengthStreamingMode(requestBody.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(requestBody);
                }
            }

            int status = connection.getResponseCode();
            if (status != 200 && status != 400) {
                return new Response(status, new byte[0]);
            }
            InputStream responseStream = status == 400 ? connection.getErrorStream() : connection.getInputStream();
            try (InputStream input = responseStream) {
                byte[] responseBody = input == null ? new byte[0] : input.readNBytes(MAX_RESPONSE_BYTES + 1);
                if (responseBody.length > MAX_RESPONSE_BYTES) {
                    throw new PaymentGatewayException(INVALID_RESPONSE);
                }
                return new Response(status, responseBody);
            }
        } catch (IOException ignored) {
            // Do not attach provider response bodies or HTTP exceptions containing a request URL.
            throw new PaymentGatewayException(UNAVAILABLE);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private JsonNode successfulData(Response response) {
        if (response.status() != 200) {
            throw new PaymentGatewayException(UNAVAILABLE);
        }
        JsonNode envelope = readResponse(response.body());
        JsonNode data = envelope.path("data");
        if (!"success".equals(envelope.path("status").asString("")) || !data.isObject()) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        return data;
    }

    private JsonNode readResponse(byte[] body) {
        try {
            JsonNode response = responseReader.readTree(body);
            if (response != null && response.isObject()) {
                return response;
            }
        } catch (JacksonException ignored) {
            // The error is reported without copying provider JSON into our diagnostics.
        }
        throw new PaymentGatewayException(INVALID_RESPONSE);
    }

    private boolean reportsMissingTransaction(byte[] body) {
        JsonNode response = readResponse(body);
        String message = response.path("message").asString("").toLowerCase(Locale.ROOT);
        return "error".equals(response.path("status").asString(""))
                && (NOT_FOUND_MESSAGES.contains(message) || "NO TX".equals(response.path("data").path("code").asString("")));
    }

    private static VerifiedPayment paymentFrom(JsonNode data) {
        String id = providerId(data.path("id"));
        String reference = requiredText(data.path("tx_ref"));
        String currency = requiredText(data.path("currency"));
        JsonNode amount = data.path("amount");
        if (!matches(TRANSACTION_ID, id) || !matches(REFERENCE, reference) || !matches(CURRENCY, currency)
                || !amount.isNumber()) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        long amountRwf;
        try {
            amountRwf = amount.decimalValue().longValueExact();
        } catch (ArithmeticException ignored) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        if (amountRwf <= 0) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }

        PaymentResult result = switch (requiredText(data.path("status"))) {
            case "successful" -> PaymentResult.PAID;
            case "pending", "processing" -> PaymentResult.PROCESSING;
            case "failed" -> PaymentResult.DECLINED;
            default -> throw new PaymentGatewayException(INVALID_RESPONSE);
        };
        return new VerifiedPayment(reference, id, amountRwf, currency, result);
    }

    private static String requiredText(JsonNode value) {
        if (!value.isString() || value.stringValue().isBlank()) {
            throw new PaymentGatewayException(INVALID_RESPONSE);
        }
        return value.stringValue();
    }

    private static boolean matches(Pattern pattern, String value) {
        return value != null && pattern.matcher(value).matches();
    }

    private static boolean isAllowedCheckoutUrl(String link) {
        try {
            URI url = URI.create(link);
            return isHttpsUrl(url) && "checkout.flutterwave.com".equalsIgnoreCase(url.getHost())
                    && matches(CHECKOUT_PATH, url.getRawPath()) && url.getRawQuery() == null;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static boolean isHttpsUrl(URI uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                && uri.getUserInfo() == null && uri.getFragment() == null
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private record Response(int status, byte[] body) { }
}
