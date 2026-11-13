package com.example.voxel.ws;

import com.example.voxel.service.VoxelWorld;
import com.example.voxel.service.VoxelWorld.Outbound;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** Native WebSocket handler (no STOMP) for the /ws endpoint, JSON protocol. */
@Component
public class VoxelWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(VoxelWebSocketHandler.class);
    private static final String CLIENT_ID_ATTR = "clientId";

    private final VoxelWorld world;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public VoxelWebSocketHandler(VoxelWorld world) {
        this.world = world;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String clientId = "u-" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        session.getAttributes().put(CLIENT_ID_ATTR, clientId);
        sessions.put(clientId, session);
        log.info("ws connected: {}", clientId);
        send(world.connect(clientId));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String clientId = (String) session.getAttributes().get(CLIENT_ID_ATTR);
        if (clientId == null) {
            return;
        }
        JsonNode node;
        try {
            node = mapper.readTree(message.getPayload());
        } catch (Exception e) {
            send(world.errorTo(clientId, "bad_block", "消息不是合法 JSON"));
            return;
        }
        String type = node.path("type").asText("");
        switch (type) {
            case "join" -> send(world.join(clientId));
            case "leave" -> send(world.leave(clientId));
            case "place" -> handlePlace(clientId, node);
            default -> send(world.errorTo(clientId, "bad_block", "未知消息类型: " + type));
        }
    }

    private void handlePlace(String clientId, JsonNode node) {
        if (!node.hasNonNull("x") || !node.hasNonNull("y") || !node.hasNonNull("z")
                || !node.hasNonNull("material") || !node.hasNonNull("color")
                || !node.get("x").isNumber() || !node.get("y").isNumber() || !node.get("z").isNumber()) {
            send(world.errorTo(clientId, "bad_block", "place 缺少 x/y/z/material/color 字段"));
            return;
        }
        send(world.place(clientId,
                node.get("x").asInt(), node.get("y").asInt(), node.get("z").asInt(),
                node.get("material").asText(), node.get("color").asText()));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String clientId = (String) session.getAttributes().get(CLIENT_ID_ATTR);
        if (clientId == null) {
            return;
        }
        sessions.remove(clientId);
        log.info("ws closed: {} ({})", clientId, status);
        send(world.disconnect(clientId));
    }

    /** 1s tick: expire overdue turns + broadcast countdown. */
    @Scheduled(fixedRate = 1000)
    public void tick() {
        if (sessions.isEmpty()) {
            return;
        }
        send(world.tick());
    }

    private void send(List<Outbound> outbounds) {
        for (Outbound o : outbounds) {
            if (o.target() == null) {
                TextMessage msg = new TextMessage(o.json());
                sessions.values().forEach(s -> sendTo(s, msg));
            } else {
                WebSocketSession s = sessions.get(o.target());
                if (s != null) {
                    sendTo(s, new TextMessage(o.json()));
                }
            }
        }
    }

    private void sendTo(WebSocketSession session, TextMessage msg) {
        // WebSocketSession is not thread-safe: serialize sends per session.
        synchronized (session) {
            if (!session.isOpen()) {
                return;
            }
            try {
                session.sendMessage(msg);
            } catch (IOException e) {
                log.warn("send failed, closing session: {}", e.getMessage());
                try {
                    session.close(CloseStatus.SERVER_ERROR);
                } catch (IOException ignored) {
                    // already closing
                }
            }
        }
    }
}
