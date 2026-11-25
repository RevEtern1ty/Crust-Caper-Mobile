package com.crustcaper.api.links;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.hamcrest.CoreMatchers.containsString;
import static org.hamcrest.CoreMatchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class AppLinksControllerTest {
    private static final String IOS_ID = "ABCDE12345.com.crustcaper.mobile.stage";
    private static final String ANDROID_PACKAGE = "com.crustcaper.mobile.stage";
    private static final String FIRST_CERTIFICATE = "9A:".repeat(31) + "9A";
    private static final String SECOND_CERTIFICATE = "B7:".repeat(31) + "B7";

    @Test
    void publishesBothAssociationFilesWithoutRedirecting() throws Exception {
        MockMvc web = web(IOS_ID, ANDROID_PACKAGE, FIRST_CERTIFICATE + ", " + SECOND_CERTIFICATE);

        web.perform(get("/.well-known/apple-app-site-association"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(header().doesNotExist("Location"))
                .andExpect(jsonPath("$.applinks.details[0].appIDs[0]").value(IOS_ID))
                .andExpect(jsonPath("$.applinks.details[0].components[0]['/']").value("/payment-return"));

        web.perform(get("/.well-known/assetlinks.json"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(header().doesNotExist("Location"))
                .andExpect(jsonPath("$[0].relation[0]").value("delegate_permission/common.handle_all_urls"))
                .andExpect(jsonPath("$[0].target.namespace").value("android_app"))
                .andExpect(jsonPath("$[0].target.package_name").value(ANDROID_PACKAGE))
                .andExpect(jsonPath("$[0].target.sha256_cert_fingerprints[0]").value(FIRST_CERTIFICATE))
                .andExpect(jsonPath("$[0].target.sha256_cert_fingerprints[1]").value(SECOND_CERTIFICATE));
    }

    @Test
    void missingPlatformIdentityIsNotAdvertised() throws Exception {
        MockMvc web = web(IOS_ID, "", "");

        web.perform(get("/.well-known/apple-app-site-association")).andExpect(status().isOk());
        web.perform(get("/.well-known/assetlinks.json"))
                .andExpect(status().isNotFound())
                .andExpect(header().string("Cache-Control", "no-store"));
    }

    @Test
    void refusesAnInvalidOrIncompletePublicAssociation() {
        assertThatThrownBy(() -> web("com.crustcaper.mobile.stage", "", ""))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> web("", ANDROID_PACKAGE, ""))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> web("", "", FIRST_CERTIFICATE))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void browserFallbackNeverReflectsPaymentStatusOrIdentifiers() throws Exception {
        web("", "", "").perform(get("/payment-return")
                        .param("orderId", "untrusted-order-reference")
                        .param("tx_ref", "untrusted-payment-reference")
                        .param("status", "successful"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("Referrer-Policy", "no-referrer"))
                .andExpect(header().doesNotExist("Location"))
                .andExpect(content().string(containsString("Return to CrustCaper")))
                .andExpect(content().string(not(containsString("untrusted-order-reference"))))
                .andExpect(content().string(not(containsString("untrusted-payment-reference"))))
                .andExpect(content().string(not(containsString("successful"))));
    }

    private MockMvc web(String iosId, String androidPackage, String certificates) {
        return MockMvcBuilders.standaloneSetup(new AppLinksController(iosId, androidPackage, certificates)).build();
    }
}
