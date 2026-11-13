package com.example.voxel.ws;

import com.example.voxel.service.SessionTokenService;
import com.example.voxel.service.VoxelProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/**
 * WebSocket handshake gate (SPEC v3): when voxel.allowed-origins is
 * configured, the request's Origin header must be on the allow-list (a
 * missing Origin is rejected too); the request must also carry a valid
 * one-time session token (?token=...) from GET /api/session. Either check
 * failing rejects the handshake with 403. The Origin check runs first so a
 * rejected handshake does not burn a token.
 */
@Component
public class SessionHandshakeInterceptor implements HandshakeInterceptor {

    private final SessionTokenService tokens;
    private final VoxelProperties props;

    public SessionHandshakeInterceptor(SessionTokenService tokens, VoxelProperties props) {
        this.tokens = tokens;
        this.props = props;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) {
        String allowed = props.getAllowedOrigins();
        if (allowed != null && !allowed.isBlank()) {
            String origin = request.getHeaders().getOrigin();
            if (origin == null || !isAllowed(origin, allowed)) {
                response.setStatusCode(HttpStatus.FORBIDDEN);
                return false;
            }
        }
        if (!tokens.consume(tokenFrom(request))) {
            response.setStatusCode(HttpStatus.FORBIDDEN);
            return false;
        }
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
        // nothing to do
    }

    /** ?token= value from the query string (null when absent). */
    private static String tokenFrom(ServerHttpRequest request) {
        String query = request.getURI().getQuery();
        if (query == null) {
            return null;
        }
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals("token")) {
                return pair.substring(eq + 1);
            }
        }
        return null;
    }

    private static boolean isAllowed(String origin, String allowedList) {
        for (String allowed : allowedList.split(",")) {
            if (origin.equals(allowed.trim())) {
                return true;
            }
        }
        return false;
    }
}
