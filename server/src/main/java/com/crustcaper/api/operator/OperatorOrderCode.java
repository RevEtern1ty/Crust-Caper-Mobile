package com.crustcaper.api.operator;

import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

record OperatorOrderCode(String predicate, Object parameter) {
    private static final Pattern SHORT = Pattern.compile("[0-9a-fA-F]{8}");
    private static final Pattern FULL = Pattern.compile("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");

    static OperatorOrderCode parse(String code) {
        if (code == null) throw OperatorFailure.invalid();
        if (SHORT.matcher(code).matches()) {
            // Keep this expression aligned with the existing orders_access_code index.
            return new OperatorOrderCode("right(o.id::text, 8) = ?", code.toLowerCase(Locale.ROOT));
        }
        if (FULL.matcher(code).matches()) {
            return new OperatorOrderCode("o.id = ?", UUID.fromString(code));
        }
        throw OperatorFailure.invalid();
    }
}
