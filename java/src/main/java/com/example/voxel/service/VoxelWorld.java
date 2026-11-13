package com.example.voxel.service;

import com.example.voxel.model.Block;
import com.example.voxel.model.Coord;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * In-memory world state + queue/turn rules (SPEC v1).
 *
 * <p>All methods are synchronized; they return outbound messages instead of
 * sending them, so no I/O happens while the lock is held. A null target
 * means broadcast to all connected clients.
 */
@Service
public class VoxelWorld {

    public static final Set<String> MATERIALS =
            Set.of("grass", "dirt", "stone", "wood", "glass", "brick");
    public static final Set<String> COLORS =
            Set.of("red", "orange", "yellow", "green", "blue", "purple", "white", "black");

    public record Outbound(String target, String json) {
        public static Outbound to(String clientId, String json) {
            return new Outbound(clientId, json);
        }

        public static Outbound all(String json) {
            return new Outbound(null, json);
        }
    }

    private final ObjectMapper mapper = new ObjectMapper();
    private final VoxelProperties props;

    private final Map<Coord, Block> blocks = new HashMap<>();
    private final Set<String> connected = new HashSet<>();
    private final Deque<String> queue = new ArrayDeque<>();
    private final Map<String, Long> placing = new HashMap<>(); // clientId -> deadline epoch millis

    public VoxelWorld(VoxelProperties props) {
        this.props = props;
    }

    // ---- lifecycle -------------------------------------------------------

    /** New connection: register + full sync to the client + queue broadcast. */
    public synchronized List<Outbound> connect(String clientId) {
        connected.add(clientId);
        return List.of(Outbound.to(clientId, initJson(clientId)), Outbound.all(queueStateJson()));
    }

    /** Disconnect: leave queue / release turn, grant the next in line. */
    public synchronized List<Outbound> disconnect(String clientId) {
        connected.remove(clientId);
        queue.remove(clientId);
        boolean wasPlacing = placing.remove(clientId) != null;
        List<Outbound> out = new ArrayList<>();
        out.add(Outbound.all(queueStateJson()));
        if (wasPlacing) {
            out.addAll(grantLocked());
        }
        return out;
    }

    // ---- queue / turn ----------------------------------------------------

    public synchronized List<Outbound> join(String clientId) {
        if (placing.containsKey(clientId) || queue.contains(clientId)) {
            return List.of(); // already queued or placing: ignore
        }
        if (queue.size() >= props.getQueueMaxLength()) {
            return List.of(Outbound.to(clientId,
                    errorJson("queue_full", "队列已满，请稍后再抢")));
        }
        queue.addLast(clientId);
        List<Outbound> granted = grantLocked();
        if (!granted.isEmpty()) {
            return granted; // grantLocked already broadcasts queue_state
        }
        return List.of(Outbound.all(queueStateJson()));
    }

    public synchronized List<Outbound> leave(String clientId) {
        if (queue.remove(clientId)) {
            return List.of(Outbound.all(queueStateJson()));
        }
        return List.of(); // only effective while queued
    }

    public synchronized List<Outbound> place(String clientId, int x, int y, int z,
                                             String material, String color) {
        // 1. must hold a live turn
        Long deadline = placing.get(clientId);
        if (deadline == null) {
            return List.of(Outbound.to(clientId,
                    errorJson("not_your_turn", "当前不是你的放置回合")));
        }
        if (deadline <= System.currentTimeMillis()) {
            // expired between ticks: release as timeout, then reject this attempt
            placing.remove(clientId);
            List<Outbound> out = new ArrayList<>();
            out.add(Outbound.to(clientId, turnReleasedJson("timeout")));
            out.add(Outbound.all(queueStateJson()));
            out.addAll(grantLocked());
            out.add(Outbound.to(clientId, errorJson("not_your_turn", "放置权已过期")));
            return out;
        }
        // invalid coordinates
        if (y < 0) {
            return List.of(Outbound.to(clientId, errorJson("bad_block", "y 不能小于 0")));
        }
        Coord coord = new Coord(x, y, z);
        // 2. target cell must be empty
        if (blocks.containsKey(coord)) {
            return List.of(Outbound.to(clientId, errorJson("cell_occupied", "该位置已有方块")));
        }
        // 3. no floating: y == 0 or at least one of the 6 neighbors exists
        if (!isSupported(coord)) {
            return List.of(Outbound.to(clientId, errorJson("floating", "方块不可以放到空中")));
        }
        // 4. material / color must be legal
        if (!MATERIALS.contains(material) || !COLORS.contains(color)) {
            return List.of(Outbound.to(clientId, errorJson("bad_block", "材质或颜色不合法")));
        }

        Block block = new Block(x, y, z, material, color);
        blocks.put(coord, block);
        placing.remove(clientId); // one block per turn
        List<Outbound> out = new ArrayList<>();
        out.add(Outbound.all(blockPlacedJson(block, clientId)));
        out.add(Outbound.to(clientId, turnReleasedJson("placed")));
        out.add(Outbound.all(queueStateJson()));
        out.addAll(grantLocked());
        return out;
    }

    /** 1s tick: expire overdue turns, then broadcast the countdown. */
    public synchronized List<Outbound> tick() {
        long now = System.currentTimeMillis();
        List<Outbound> out = new ArrayList<>();
        List<String> expired = new ArrayList<>();
        for (Map.Entry<String, Long> e : placing.entrySet()) {
            if (e.getValue() <= now) {
                expired.add(e.getKey());
            }
        }
        if (!expired.isEmpty()) {
            for (String id : expired) {
                placing.remove(id);
                out.add(Outbound.to(id, turnReleasedJson("timeout")));
            }
            out.add(Outbound.all(queueStateJson()));
            out.addAll(grantLocked());
        }
        out.add(Outbound.all(countdownJson(now)));
        return out;
    }

    /** Send a one-off error to one client (e.g. malformed message). */
    public synchronized List<Outbound> errorTo(String clientId, String code, String message) {
        return List.of(Outbound.to(clientId, errorJson(code, message)));
    }

    // ---- REST snapshot ---------------------------------------------------

    public synchronized Map<String, Object> snapshot() {
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("blocks", new ArrayList<>(blocks.values()));
        snap.put("waiting", new ArrayList<>(queue));
        snap.put("placing", placingList());
        snap.put("online", connected.size());
        snap.put("config", configMap());
        return snap;
    }

    public synchronized Map<String, Object> configMap() {
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("turnSeconds", props.getTurnSeconds());
        cfg.put("placersMax", props.getPlacersMax());
        cfg.put("queueMaxLength", props.getQueueMaxLength());
        return cfg;
    }

    // ---- internals -------------------------------------------------------

    /** Fill free placer slots from the head of the queue. Caller holds the lock. */
    private List<Outbound> grantLocked() {
        List<Outbound> out = new ArrayList<>();
        boolean grantedAny = false;
        while (placing.size() < props.getPlacersMax() && !queue.isEmpty()) {
            String id = queue.removeFirst();
            long deadline = System.currentTimeMillis() + props.getTurnSeconds() * 1000L;
            placing.put(id, deadline);
            out.add(Outbound.to(id, turnGrantedJson(deadline)));
            grantedAny = true;
        }
        if (grantedAny) {
            out.add(Outbound.all(queueStateJson()));
        }
        return out;
    }

    private boolean isSupported(Coord c) {
        if (c.y() == 0) {
            return true;
        }
        return blocks.containsKey(new Coord(c.x() + 1, c.y(), c.z()))
                || blocks.containsKey(new Coord(c.x() - 1, c.y(), c.z()))
                || blocks.containsKey(new Coord(c.x(), c.y() + 1, c.z()))
                || blocks.containsKey(new Coord(c.x(), c.y() - 1, c.z()))
                || blocks.containsKey(new Coord(c.x(), c.y(), c.z() + 1))
                || blocks.containsKey(new Coord(c.x(), c.y(), c.z() - 1));
    }

    private List<Map<String, Object>> placingList() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map.Entry<String, Long> e : placing.entrySet()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("clientId", e.getKey());
            m.put("deadline", e.getValue());
            list.add(m);
        }
        return list;
    }

    // ---- JSON builders ---------------------------------------------------

    private String initJson(String clientId) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "init");
        ArrayNode arr = root.putArray("blocks");
        for (Block b : blocks.values()) {
            arr.add(blockNode(b));
        }
        root.set("config", mapper.valueToTree(configMap()));
        ObjectNode me = root.putObject("me");
        me.put("clientId", clientId);
        me.put("state", placing.containsKey(clientId) ? "placing"
                : queue.contains(clientId) ? "queued" : "watching");
        root.put("online", connected.size());
        return root.toString();
    }

    private String queueStateJson() {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "queue_state");
        ArrayNode waiting = root.putArray("waiting");
        queue.forEach(waiting::add);
        ArrayNode placingArr = root.putArray("placing");
        for (Map.Entry<String, Long> e : placing.entrySet()) {
            ObjectNode p = placingArr.addObject();
            p.put("clientId", e.getKey());
            p.put("deadline", e.getValue());
        }
        root.put("online", connected.size());
        return root.toString();
    }

    private String countdownJson(long now) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "countdown");
        ArrayNode arr = root.putArray("placing");
        for (Map.Entry<String, Long> e : placing.entrySet()) {
            ObjectNode p = arr.addObject();
            p.put("clientId", e.getKey());
            p.put("secondsLeft", Math.max(0, (int) Math.ceil((e.getValue() - now) / 1000.0)));
        }
        return root.toString();
    }

    private String turnGrantedJson(long deadline) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "turn_granted");
        root.put("deadline", deadline);
        return root.toString();
    }

    private String turnReleasedJson(String reason) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "turn_released");
        root.put("reason", reason);
        return root.toString();
    }

    private String blockPlacedJson(Block b, String by) {
        ObjectNode root = blockNode(b);
        root.put("type", "block_placed");
        root.put("by", by);
        return root.toString();
    }

    private ObjectNode blockNode(Block b) {
        ObjectNode n = mapper.createObjectNode();
        n.put("x", b.x());
        n.put("y", b.y());
        n.put("z", b.z());
        n.put("material", b.material());
        n.put("color", b.color());
        return n;
    }

    private String errorJson(String code, String message) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "error");
        root.put("code", code);
        root.put("message", message);
        return root.toString();
    }
}
