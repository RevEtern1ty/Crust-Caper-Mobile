package com.crustcaper.api;

import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

@Component
final class CommerceJson {
    private final ObjectMapper mapper;

    CommerceJson(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    String write(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JacksonException ignored) {
            throw ApiFailure.unavailable();
        }
    }

    <T> T read(String value, Class<T> type) {
        try {
            return mapper.readValue(value, type);
        } catch (JacksonException ignored) {
            throw ApiFailure.unavailable();
        }
    }

    <T> T read(String value, TypeReference<T> type) {
        try {
            return mapper.readValue(value, type);
        } catch (JacksonException ignored) {
            throw ApiFailure.unavailable();
        }
    }
}
