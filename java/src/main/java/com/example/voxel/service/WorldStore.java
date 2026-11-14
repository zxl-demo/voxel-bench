package com.example.voxel.service;

import com.example.voxel.model.Block;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/**
 * File snapshot persistence for the confirmed world (SPEC v4).
 *
 * <p>Format: JSON {@code {"version":1,"blocks":[...]}} where each block has
 * the same shape as /api/state (x, y, z, material, color, by, placedAt,
 * pending=false, byId). Only confirmed blocks are stored; pending blocks
 * are per-turn state and never survive a restart (same as a disconnect).
 *
 * <p>Saves are atomic: write to {@code <file>.tmp}, then rename over the
 * target, so a crash mid-write can never leave a half-written world file.
 * Loading validates every entry and skips bad ones instead of dropping the
 * whole world; a file that exists but is not parseable at all fails startup
 * (loudly, via exception) so a corrupt snapshot is never silently wiped by
 * an empty world being saved over it.
 *
 * <p>Disabled when {@code voxel.persistence-file} is empty (local dev).
 */
@Component
public class WorldStore {

    private static final Logger log = LoggerFactory.getLogger(WorldStore.class);

    private final ObjectMapper mapper = new ObjectMapper();
    private final Path file; // null when persistence is disabled

    public WorldStore(VoxelProperties props) {
        String configured = props.getPersistenceFile();
        this.file = (configured == null || configured.isBlank()) ? null : Path.of(configured.trim());
    }

    public boolean isEnabled() {
        return file != null;
    }

    /**
     * Load confirmed blocks. Empty list when disabled or when no snapshot
     * file exists yet (first run). Throws IllegalStateException when a
     * snapshot file exists but cannot be parsed at all.
     */
    public List<Block> load() {
        List<Block> blocks = new ArrayList<>();
        if (file == null) {
            return blocks;
        }
        if (!Files.isRegularFile(file)) {
            log.info("no world snapshot at {}, starting with an empty world", file);
            return blocks;
        }
        try {
            JsonNode root = mapper.readTree(file.toFile());
            JsonNode arr = root.path("blocks");
            if (!arr.isArray()) {
                throw new IllegalStateException("world snapshot " + file + " has no blocks array");
            }
            int skipped = 0;
            for (JsonNode n : arr) {
                Block b = parseBlock(n);
                if (b == null) {
                    skipped++;
                    continue;
                }
                blocks.add(b);
            }
            log.info("loaded {} confirmed blocks from {} ({} skipped)", blocks.size(), file, skipped);
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException(
                    "world snapshot " + file + " is not readable: " + e.getMessage(), e);
        }
        return blocks;
    }

    /** Atomically persist the given confirmed blocks. No-op when disabled. Never throws. */
    public void save(List<Block> blocks) {
        if (file == null) {
            return;
        }
        try {
            Path parent = file.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            ObjectNode root = mapper.createObjectNode();
            root.put("version", 1);
            ArrayNode arr = root.putArray("blocks");
            for (Block b : blocks) {
                ObjectNode n = arr.addObject();
                n.put("x", b.x());
                n.put("y", b.y());
                n.put("z", b.z());
                n.put("material", b.material());
                n.put("color", b.color());
                n.put("by", b.by());
                n.put("placedAt", b.placedAt()); // Jackson writes null for null Long
                n.put("pending", false);
                n.put("byId", b.byId());
            }
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.writeString(tmp, mapper.writeValueAsString(root));
            try {
                Files.move(tmp, file,
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
            }
            log.debug("saved {} confirmed blocks to {}", blocks.size(), file);
        } catch (Exception e) {
            // Never crash the app over a failed save: the in-memory world is
            // unaffected, and the next mutation retries (dirty is re-set).
            log.error("failed to save world snapshot to {}: {}", file, e.getMessage());
        }
    }

    /** Null for an invalid entry (bad coords/material/color). pending is always false on load. */
    private Block parseBlock(JsonNode n) {
        try {
            if (!n.hasNonNull("x") || !n.hasNonNull("y") || !n.hasNonNull("z")
                    || !n.hasNonNull("material") || !n.hasNonNull("color")) {
                return null;
            }
            int x = n.get("x").asInt();
            int y = n.get("y").asInt();
            int z = n.get("z").asInt();
            String material = n.get("material").asText();
            String color = n.get("color").asText();
            if (y < 0 || !VoxelWorld.MATERIALS.contains(material) || !VoxelWorld.COLORS.contains(color)) {
                return null;
            }
            String by = n.path("by").asText(null);
            Long placedAt = n.hasNonNull("placedAt") ? n.get("placedAt").asLong() : null;
            String byId = n.path("byId").asText(null);
            return new Block(x, y, z, material, color, by, placedAt, false, byId);
        } catch (Exception e) {
            return null;
        }
    }
}
