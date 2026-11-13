package com.example.voxel.web;

import com.example.voxel.service.VoxelWorld;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Debug / fallback REST endpoints (SPEC v1). */
@RestController
public class StateController {

    private final VoxelWorld world;

    public StateController(VoxelWorld world) {
        this.world = world;
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
}
