package com.crustcaper.api.operator;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.stream.IntStream;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.io.RandomAccessReadBuffer;
import org.apache.pdfbox.pdfparser.PDFParser;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPageTree;
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
        if (declared >= 0 && body.length != declared) throw OperatorFailure.invalid();
        if (!hasPdfMarkers(body)) throw invalidPdf();
        return body;
    }

    static boolean usable(byte[] body) {
        try (var source = new RandomAccessReadBuffer(body);
             var document = new PDFParser(source).parse(false)) {
            return !document.isEncrypted() && hasUsablePage(document);
        } catch (IOException | RuntimeException | StackOverflowError ignored) {
            // Parser errors can include details from the uploaded file.
            return false;
        }
    }

    private static boolean hasUsablePage(PDDocument document) {
        var catalog = document.getDocumentCatalog().getCOSObject();
        var tree = catalog.getCOSDictionary(COSName.PAGES);
        if (!COSName.CATALOG.equals(catalog.getCOSName(COSName.TYPE))
            || tree == null || !COSName.PAGES.equals(tree.getCOSName(COSName.TYPE))) return false;
        for (var page : document.getPages()) {
            if (PDPageTree.getInheritableAttribute(page.getCOSObject(), COSName.MEDIA_BOX) instanceof COSArray box
                && box.size() == 4 && IntStream.range(0, 4).allMatch(index -> box.getObject(index) instanceof COSNumber)) {
                var dimensions = page.getMediaBox();
                float width = dimensions.getWidth();
                float height = dimensions.getHeight();
                if (Float.isFinite(width) && width > 0 && Float.isFinite(height) && height > 0) return true;
            }
        }
        return false;
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

    static OperatorFailure invalidPdf() {
        return new OperatorFailure(HttpStatus.BAD_REQUEST, "invalid_receipt_pdf");
    }
}
