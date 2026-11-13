package com.example.voxel.ws;

import com.example.voxel.service.VoxelProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final VoxelWebSocketHandler handler;
    private final SessionHandshakeInterceptor handshakeInterceptor;
    private final VoxelProperties props;

    public WebSocketConfig(VoxelWebSocketHandler handler,
                           SessionHandshakeInterceptor handshakeInterceptor,
                           VoxelProperties props) {
        this.handler = handler;
        this.handshakeInterceptor = handshakeInterceptor;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // setAllowedOrigins mirrors the configured allow-list (open when empty,
        // local dev only); the interceptor enforces the same list plus the token.
        String allowed = props.getAllowedOrigins();
        String[] origins = (allowed == null || allowed.isBlank())
                ? new String[]{"*"}
                : allowed.split("\\s*,\\s*");
        registry.addHandler(handler, "/ws")
                .addInterceptors(handshakeInterceptor)
                .setAllowedOrigins(origins);
    }
}
