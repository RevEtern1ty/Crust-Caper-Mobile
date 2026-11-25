package com.crustcaper.api.links;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class AppLinksController {
    private static final String PAYMENT_RETURN = "/payment-return";
    private static final Pattern PACKAGE = Pattern.compile("[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+");
    private static final Pattern APPLE_APP_ID = Pattern.compile("[A-Z0-9]{10}\\." + PACKAGE.pattern());
    private static final Pattern SHA256 = Pattern.compile("[0-9A-F]{2}(?::[0-9A-F]{2}){31}");
    private static final CacheControl ASSOCIATION_CACHE = CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic();
    private static final Resource RETURN_PAGE = new ClassPathResource("payment-return.html");

    private final Map<String, ?> appleAssociation;
    private final List<Map<String, ?>> androidAssociation;

    AppLinksController(@Value("${crustcaper.app-links.ios-app-id:}") String iosAppId,
                       @Value("${crustcaper.app-links.android-package:}") String androidPackage,
                       @Value("${crustcaper.app-links.android-fingerprints:}") String fingerprints) {
        appleAssociation = appleAssociation(iosAppId.strip());
        androidAssociation = androidAssociation(androidPackage.strip(), fingerprints.strip());
    }

    @GetMapping(path = "/.well-known/apple-app-site-association", produces = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<Map<String, ?>> apple() {
        return association(appleAssociation);
    }

    @GetMapping(path = "/.well-known/assetlinks.json", produces = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<List<Map<String, ?>>> android() {
        return association(androidAssociation);
    }

    @GetMapping(path = PAYMENT_RETURN, produces = MediaType.TEXT_HTML_VALUE)
    ResponseEntity<Resource> paymentReturn() {
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/html; charset=UTF-8"))
                .cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "no-referrer")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; "
                        + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
                .body(RETURN_PAGE);
    }

    private static <T> ResponseEntity<T> association(T value) {
        if (value == null) return ResponseEntity.status(404).cacheControl(CacheControl.noStore()).build();
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).cacheControl(ASSOCIATION_CACHE).body(value);
    }

    private static Map<String, ?> appleAssociation(String appId) {
        if (appId.isEmpty()) return null;
        if (!APPLE_APP_ID.matcher(appId).matches()) {
            throw new IllegalArgumentException("Set a valid CRUSTCAPER_APP_LINK_IOS_APP_ID.");
        }
        return Map.of("applinks", Map.of("details", List.of(Map.of(
                "appIDs", List.of(appId), "components", List.of(Map.of("/", PAYMENT_RETURN))))));
    }

    private static List<Map<String, ?>> androidAssociation(String packageName, String rawFingerprints) {
        if (packageName.isEmpty() && rawFingerprints.isEmpty()) return null;
        if (!PACKAGE.matcher(packageName).matches()) {
            throw new IllegalArgumentException("Set a valid CRUSTCAPER_APP_LINK_ANDROID_PACKAGE.");
        }
        var fingerprints = Arrays.stream(rawFingerprints.split(",", -1))
                .map(value -> value.strip().toUpperCase(Locale.ROOT)).distinct().toList();
        if (fingerprints.size() > 8 || fingerprints.stream().anyMatch(value -> !SHA256.matcher(value).matches())) {
            throw new IllegalArgumentException("Set valid CRUSTCAPER_APP_LINK_ANDROID_FINGERPRINTS.");
        }
        return List.of(Map.of("relation", List.of("delegate_permission/common.handle_all_urls"),
                "target", Map.of("namespace", "android_app", "package_name", packageName,
                        "sha256_cert_fingerprints", fingerprints)));
    }
}
