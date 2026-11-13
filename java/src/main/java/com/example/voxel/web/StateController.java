package com.example.voxel.web;

import com.example.voxel.service.SessionTokenService;
import com.example.voxel.service.VoxelWorld;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Debug / fallback REST endpoints (SPEC v3). */
@RestController
public class StateController {

    private final VoxelWorld world;
    private final SessionTokenService tokens;

    public StateController(VoxelWorld world, SessionTokenService tokens) {
        this.world = world;
        this.tokens = tokens;
    }

    /** Full block list + queue snapshot + config. */
    @GetMapping("/api/state")
    public Map<String, Object> state() {
        return world.snapshot();
    }

    /** Effective config. */
    @GetMapping("/api/config")
    public Map<String, Object> config() {
        return world.configMap();
    }

    /** One-time session token for the WebSocket handshake (5 min TTL). */
    @GetMapping("/api/session")
    public Map<String, String> session() {
        return Map.of("token", tokens.issue());
    }
}
