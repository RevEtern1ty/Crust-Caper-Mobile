package com.crustcaper.api.recovery;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

final class LocalPhoneVerificationGateway implements PhoneVerificationGateway {
    static final String FIXTURE_PHONE = "+250700000000";
    static final String FIXTURE_CODE = "418263";
    private static final Duration LIFETIME = Duration.ofMinutes(10);

    private final Clock clock;
    private final Map<String, Instant> pending = new HashMap<>();

    LocalPhoneVerificationGateway(Clock clock) {
        this.clock = clock;
    }

    @Override
    public synchronized String send(String phone) {
        if (!FIXTURE_PHONE.equals(phone)) {
            throw new PhoneVerificationException(PhoneVerificationException.Kind.UNAVAILABLE);
        }
        Instant now = clock.instant();
        pending.values().removeIf(expiry -> !expiry.isAfter(now));
        String sid = "VE" + UUID.randomUUID().toString().replace("-", "");
        pending.put(sid, now.plus(LIFETIME));
        return sid;
    }

    @Override
    public synchronized VerificationCheck check(String verificationSid, String code) {
        Instant expiry = pending.get(verificationSid);
        if (expiry == null || !expiry.isAfter(clock.instant())) {
            pending.remove(verificationSid);
            return VerificationCheck.EXPIRED;
        }
        if (!FIXTURE_CODE.equals(code)) {
            return VerificationCheck.INVALID;
        }
        pending.remove(verificationSid);
        return VerificationCheck.APPROVED;
    }
}
