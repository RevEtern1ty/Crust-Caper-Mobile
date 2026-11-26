package com.crustcaper.api;

import java.net.URI;
import java.util.Locale;

public final class WebOrigin {
    private WebOrigin() {}

    public static String parse(String value) {
        if (value == null || value.isEmpty()) return null;
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException ignored) {
            throw invalid();
        }
        String host = uri.getHost();
        if (host == null || !value.equals("https://" + host.toLowerCase(Locale.ROOT))) throw invalid();
        return value;
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("CRUSTCAPER_WEB_ORIGIN must be a canonical HTTPS origin on port 443");
    }
}
