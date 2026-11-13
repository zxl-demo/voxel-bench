package com.example.voxel.service;

import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * One-time browser session tokens for the WebSocket handshake (SPEC v3).
 *
 * <p>Tokens are random UUIDs, single-use (consumed atomically on handshake),
 * expire after 5 minutes, and the map is capped at about 1000 entries;
 * issuing a token also sweeps expired entries. This only stops casual
 * direct-script connections — anyone can fetch a token from /api/session
 * and forge an Origin header (see SPEC v3, "能力边界").
 */
@Service
public class SessionTokenService {

    private static final long TTL_MILLIS = 5 * 60 * 1000L;
    private static final int MAX_TOKENS = 1000;

    private final Map<String, Long> tokens = new ConcurrentHashMap<>(); // token -> expiry epoch millis

    /** Issue a fresh one-time token (also sweeps expired ones). */
    public String issue() {
        sweepExpired();
        if (tokens.size() >= MAX_TOKENS) {
            evictEarliest();
        }
        String token = UUID.randomUUID().toString().replace("-", "");
        tokens.put(token, System.currentTimeMillis() + TTL_MILLIS);
        return token;
    }

    /** Atomically consume a token: true only if it exists and has not expired. */
    public boolean consume(String token) {
        if (token == null || token.isEmpty()) {
            return false;
        }
        Long expiry = tokens.remove(token);
        return expiry != null && expiry > System.currentTimeMillis();
    }

    private void sweepExpired() {
        long now = System.currentTimeMillis();
        tokens.entrySet().removeIf(e -> e.getValue() <= now);
    }

    /** Drop the single earliest-expiring token to stay under the cap. */
    private void evictEarliest() {
        String earliest = null;
        long min = Long.MAX_VALUE;
        for (Map.Entry<String, Long> e : tokens.entrySet()) {
            if (e.getValue() < min) {
                min = e.getValue();
                earliest = e.getKey();
            }
        }
        if (earliest != null) {
            tokens.remove(earliest);
        }
    }
}
