package com.crustcaper.api.operator;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;

final class ReceiptPdf {
    static final int LIMIT = 1_048_576;
    private static final byte[] HEADER = "%PDF-".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] FOOTER = "%%EOF".getBytes(StandardCharsets.US_ASCII);

    private ReceiptPdf() {}

    static byte[] read(HttpServletRequest request) {
        String encoding = request.getHeader(HttpHeaders.CONTENT_ENCODING);
        if (!pdfContentType(request.getContentType()) || (encoding != null && !encoding.equalsIgnoreCase("identity"))) {
            throw new OperatorFailure(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type");
        }
        long declared = request.getContentLengthLong();
        if (declared > LIMIT) throw tooLarge();
        byte[] body;
        try {
            body = request.getInputStream().readNBytes(LIMIT + 1);
        } catch (IOException ignored) {
            throw OperatorFailure.invalid();
        }
        if (body.length > LIMIT) throw tooLarge();
        if ((declared >= 0 && body.length != declared) || !hasPdfMarkers(body)) throw OperatorFailure.invalid();
        return body;
    }

    private static boolean pdfContentType(String raw) {
        if (raw == null) return false;
        try {
            MediaType type = MediaType.parseMediaType(raw);
            return type.getType().equalsIgnoreCase("application") && type.getSubtype().equalsIgnoreCase("pdf");
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static boolean hasPdfMarkers(byte[] body) {
        if (body.length < 14 || !matches(body, HEADER, 0) || !digit(body[5]) || body[6] != '.' || !digit(body[7])) {
            return false;
        }
        int end = body.length;
        while (end > 8 && whitespace(body[end - 1])) end--;
        return end >= 8 + FOOTER.length && matches(body, FOOTER, end - FOOTER.length);
    }

    private static boolean matches(byte[] body, byte[] marker, int offset) {
        for (int i = 0; i < marker.length; i++) {
            if (body[offset + i] != marker[i]) return false;
        }
        return true;
    }

    private static boolean digit(byte value) {
        return value >= '0' && value <= '9';
    }

    private static boolean whitespace(byte value) {
        return value == 0 || value == ' ' || value == '\n' || value == '\r' || value == '\t' || value == '\f';
    }

    private static OperatorFailure tooLarge() {
        return new OperatorFailure(HttpStatus.CONTENT_TOO_LARGE, "receipt_too_large");
    }
}
