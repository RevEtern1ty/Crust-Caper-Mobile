package com.crustcaper.api.recovery;

public interface PhoneVerificationGateway {
    String send(String phone);

    VerificationCheck check(String verificationSid, String code);

    enum VerificationCheck {
        APPROVED, INVALID, EXPIRED
    }
}
