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
import java.util.concurrent.ThreadLocalRandom;

/**
 * In-memory world state + queue/turn rules (SPEC v2).
 *
 * <p>All methods are synchronized; they return outbound messages instead of
 * sending them, so no I/O happens while the lock is held. A null target
 * means broadcast to all connected clients.
 *
 * <p>v2 model: confirmed blocks live in {@code blocks}; blocks placed this
 * turn stay in {@code pending} until {@link #confirm} moves them over (or
 * timeout / cancel / disconnect clears them). A pending block only supports
 * its own owner's blocks, so a timeout cleanup can never strand someone
 * else's block in mid-air.
 */
@Service
public class VoxelWorld {

    public static final Set<String> MATERIALS =
            Set.of("grass", "dirt", "stone", "wood", "glass", "brick");
    public static final Set<String> COLORS =
            Set.of("red", "orange", "yellow", "green", "blue", "purple", "white", "black");

    private static final String[] NICK_ADJECTIVES = {
            "快乐", "闪亮", "硬核", "安静", "飞翔", "迷糊", "勇敢", "温柔", "机灵", "淡定"};
    private static final String[] NICK_NOUNS = {
            "砖匠", "建筑师", "方块君", "矿工", "工匠", "探险家", "设计师", "雕刻家", "造物主", "筑梦师"};

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

    private final Map<Coord, Block> blocks = new HashMap<>();  // confirmed
    private final Map<Coord, Block> pending = new HashMap<>(); // pending confirmation
    private final Map<String, String> nicknames = new HashMap<>(); // clientId -> nickname
    private final Set<String> connected = new HashSet<>();
    private final Deque<String> queue = new ArrayDeque<>();
    private final Map<String, Long> placing = new HashMap<>(); // clientId -> deadline epoch millis

    public VoxelWorld(VoxelProperties props) {
        this.props = props;
    }

    // ---- lifecycle -------------------------------------------------------

    /** New connection: assign a random nickname, full sync, queue broadcast. */
    public synchronized List<Outbound> connect(String clientId) {
        connected.add(clientId);
        nicknames.put(clientId, assignNickname(clientId));
        return List.of(Outbound.to(clientId, initJson(clientId)), Outbound.all(queueStateJson()));
    }

    /** Disconnect: leave queue / release turn, clear own pending, free nickname. */
    public synchronized List<Outbound> disconnect(String clientId) {
        connected.remove(clientId);
        queue.remove(clientId);
        nicknames.remove(clientId);
        List<Outbound> out = new ArrayList<>();
        if (placing.remove(clientId) != null) {
            out.addAll(clearPendingLocked(clientId, "disconnect"));
            out.add(Outbound.all(queueStateJson()));
            out.addAll(grantLocked());
        } else {
            out.add(Outbound.all(queueStateJson()));
        }
        return out;
    }

    // ---- nickname --------------------------------------------------------

    public synchronized List<Outbound> rename(String clientId, String nickname) {
        String name = nickname == null ? "" : nickname.trim();
        if (name.isEmpty() || name.length() > 12 || hasControlChar(name)) {
            return List.of(Outbound.to(clientId,
                    errorJson("name_invalid", "昵称需为 1–12 个字符，不能含控制字符")));
        }
        if (name.equals(nicknames.get(clientId))) {
            return List.of(); // unchanged
        }
        if (nicknames.containsValue(name)) {
            return List.of(Outbound.to(clientId, errorJson("name_taken", "这个昵称已被占用")));
        }
        nicknames.put(clientId, name);
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "renamed");
        root.put("clientId", clientId);
        root.put("nickname", name);
        return List.of(Outbound.all(root.toString()), Outbound.all(queueStateJson()));
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

    // ---- placement -------------------------------------------------------

    public synchronized List<Outbound> place(String clientId, int x, int y, int z,
                                             String material, String color) {
        List<Outbound> err = requireLiveTurn(clientId);
        if (err != null) {
            return err;
        }
        // per-turn quota
        if (pendingCount(clientId) >= props.getBlocksPerTurn()) {
            return List.of(Outbound.to(clientId,
                    errorJson("quota_exceeded", "本轮已放满，请先确认放置")));
        }
        if (y < 0) {
            return List.of(Outbound.to(clientId, errorJson("bad_block", "y 不能小于 0")));
        }
        Coord coord = new Coord(x, y, z);
        // target cell must be empty (confirmed or anyone's pending)
        if (blocks.containsKey(coord) || pending.containsKey(coord)) {
            return List.of(Outbound.to(clientId, errorJson("cell_occupied", "该位置已有方块")));
        }
        // no floating: y == 0 or a neighbor in blocks / own pending
        if (!isSupported(coord, clientId)) {
            return List.of(Outbound.to(clientId, errorJson("floating", "方块不可以放到空中")));
        }
        if (!MATERIALS.contains(material) || !COLORS.contains(color)) {
            return List.of(Outbound.to(clientId, errorJson("bad_block", "材质或颜色不合法")));
        }

        Block block = new Block(x, y, z, material, color,
                nicknameOf(clientId), null, true, clientId);
        pending.put(coord, block);
        // turn is kept; queue_state carries the new pendingCount
        return List.of(
                Outbound.all(blockPlacedJson(block)),
                Outbound.all(queueStateJson()));
    }

    public synchronized List<Outbound> move(String clientId,
                                            int fromX, int fromY, int fromZ,
                                            int toX, int toY, int toZ) {
        List<Outbound> err = requireLiveTurn(clientId);
        if (err != null) {
            return err;
        }
        Coord from = new Coord(fromX, fromY, fromZ);
        Block block = pending.get(from);
        if (block == null) {
            return List.of(Outbound.to(clientId,
                    errorJson("no_such_block", "该位置没有待确认方块")));
        }
        if (!clientId.equals(block.byId())) {
            return List.of(Outbound.to(clientId,
                    errorJson("not_pending_owner", "不能移动别人的方块")));
        }
        if (toY < 0) {
            return List.of(Outbound.to(clientId, errorJson("bad_block", "y 不能小于 0")));
        }
        Coord to = new Coord(toX, toY, toZ);
        if (!to.equals(from) && (blocks.containsKey(to) || pending.containsKey(to))) {
            return List.of(Outbound.to(clientId, errorJson("cell_occupied", "目标位置已有方块")));
        }
        Set<Coord> simulated = ownPendingCoords(clientId);
        simulated.remove(from);
        simulated.add(to);
        if (!allPendingSupported(simulated)) {
            return List.of(Outbound.to(clientId,
                    errorJson("would_float", "移动后会有方块悬空")));
        }
        pending.remove(from);
        pending.put(to, new Block(toX, toY, toZ, block.material(), block.color(),
                block.by(), null, true, clientId));
        return List.of(Outbound.all(blockMovedJson(from, to, block)));
    }

    public synchronized List<Outbound> remove(String clientId, int x, int y, int z) {
        List<Outbound> err = requireLiveTurn(clientId);
        if (err != null) {
            return err;
        }
        Coord coord = new Coord(x, y, z);
        Block block = pending.get(coord);
        if (block == null) {
            return List.of(Outbound.to(clientId,
                    errorJson("no_such_block", "该位置没有待确认方块")));
        }
        if (!clientId.equals(block.byId())) {
            return List.of(Outbound.to(clientId,
                    errorJson("not_pending_owner", "不能移除别人的方块")));
        }
        Set<Coord> simulated = ownPendingCoords(clientId);
        simulated.remove(coord);
        if (!allPendingSupported(simulated)) {
            return List.of(Outbound.to(clientId,
                    errorJson("would_float", "移除后会有方块悬空")));
        }
        pending.remove(coord);
        return List.of(
                Outbound.all(blockRemovedJson(coord, "removed")),
                Outbound.all(queueStateJson()));
    }

    /** Confirm all own pending blocks, then release the turn. */
    public synchronized List<Outbound> confirm(String clientId) {
        List<Outbound> err = requireLiveTurn(clientId);
        if (err != null) {
            return err;
        }
        List<Outbound> out = new ArrayList<>();
        long now = System.currentTimeMillis();
        String nickname = nicknameOf(clientId);
        List<Block> confirmed = new ArrayList<>();
        for (Coord coord : ownPendingCoords(clientId)) {
            Block p = pending.remove(coord);
            Block done = new Block(p.x(), p.y(), p.z(), p.material(), p.color(),
                    nickname, now, false, clientId);
            blocks.put(coord, done);
            confirmed.add(done);
        }
        if (!confirmed.isEmpty()) {
            out.add(Outbound.all(blocksConfirmedJson(confirmed)));
        }
        out.addAll(releaseTurnLocked(clientId, "confirmed", true));
        return out;
    }

    /** Clear all own pending blocks and give up the turn. */
    public synchronized List<Outbound> cancel(String clientId) {
        List<Outbound> err = requireLiveTurn(clientId);
        if (err != null) {
            return err;
        }
        return releaseTurnLocked(clientId, "cancelled", true);
    }

    /** 1s tick: expire overdue turns (clearing their pending), broadcast countdown. */
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
                List<Outbound> cleared = clearPendingLocked(id, "timeout");
                out.addAll(cleared);
                out.add(Outbound.to(id, turnReleasedJson("timeout", cleared.size())));
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
        List<Block> all = new ArrayList<>(blocks.values());
        all.addAll(pending.values());
        snap.put("blocks", all);
        snap.put("waiting", waitingList());
        snap.put("placing", placingList());
        snap.put("online", connected.size());
        snap.put("config", configMap());
        return snap;
    }

    public synchronized Map<String, Object> configMap() {
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("turnSeconds", props.getTurnSeconds());
        cfg.put("blocksPerTurn", props.getBlocksPerTurn());
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

    /**
     * Release a turn: clear the owner's pending blocks (reason), notify the
     * owner, broadcast queue state, grant the next in line. Caller holds the
     * lock. For "confirmed" the pending set is already empty (confirm moved
     * them to blocks first), so no block_removed is emitted.
     */
    private List<Outbound> releaseTurnLocked(String clientId, String reason, boolean notifyClient) {
        List<Outbound> out = new ArrayList<>();
        placing.remove(clientId);
        List<Outbound> cleared = clearPendingLocked(clientId, reason);
        out.addAll(cleared);
        if (notifyClient) {
            out.add(Outbound.to(clientId, turnReleasedJson(reason, cleared.size())));
        }
        out.add(Outbound.all(queueStateJson()));
        out.addAll(grantLocked());
        return out;
    }

    /** An action arrived after the turn expired: release it, then report not_your_turn. */
    private List<Outbound> expiredTurnLocked(String clientId) {
        List<Outbound> out = new ArrayList<>(releaseTurnLocked(clientId, "timeout", true));
        out.add(Outbound.to(clientId, errorJson("not_your_turn", "放置权已过期")));
        return out;
    }

    /** Null when the client holds a live turn, otherwise the error outbounds. */
    private List<Outbound> requireLiveTurn(String clientId) {
        Long deadline = placing.get(clientId);
        if (deadline == null) {
            return List.of(Outbound.to(clientId,
                    errorJson("not_your_turn", "当前不是你的放置回合")));
        }
        if (deadline <= System.currentTimeMillis()) {
            return expiredTurnLocked(clientId);
        }
        return null;
    }

    /** Remove all of one client's pending blocks, one block_removed broadcast each. */
    private List<Outbound> clearPendingLocked(String clientId, String reason) {
        List<Outbound> out = new ArrayList<>();
        for (Coord coord : ownPendingCoords(clientId)) {
            pending.remove(coord);
            out.add(Outbound.all(blockRemovedJson(coord, reason)));
        }
        return out;
    }

    private int pendingCount(String clientId) {
        int n = 0;
        for (Block b : pending.values()) {
            if (clientId.equals(b.byId())) {
                n++;
            }
        }
        return n;
    }

    private Set<Coord> ownPendingCoords(String clientId) {
        Set<Coord> coords = new HashSet<>();
        for (Map.Entry<Coord, Block> e : pending.entrySet()) {
            if (clientId.equals(e.getValue().byId())) {
                coords.add(e.getKey());
            }
        }
        return coords;
    }

    /** y == 0, or a neighbor in confirmed blocks, or a neighbor in the owner's own pending. */
    private boolean isSupported(Coord c, String ownerId) {
        if (c.y() == 0) {
            return true;
        }
        for (Coord n : neighbors(c)) {
            if (blocks.containsKey(n)) {
                return true;
            }
            Block p = pending.get(n);
            if (p != null && ownerId.equals(p.byId())) {
                return true;
            }
        }
        return false;
    }

    /** Every coord in the simulated own-pending set must be supported by blocks ∪ the set itself. */
    private boolean allPendingSupported(Set<Coord> simulated) {
        for (Coord c : simulated) {
            if (c.y() == 0) {
                continue;
            }
            boolean ok = false;
            for (Coord n : neighbors(c)) {
                if (blocks.containsKey(n) || simulated.contains(n)) {
                    ok = true;
                    break;
                }
            }
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    private static List<Coord> neighbors(Coord c) {
        return List.of(
                new Coord(c.x() + 1, c.y(), c.z()),
                new Coord(c.x() - 1, c.y(), c.z()),
                new Coord(c.x(), c.y() + 1, c.z()),
                new Coord(c.x(), c.y() - 1, c.z()),
                new Coord(c.x(), c.y(), c.z() + 1),
                new Coord(c.x(), c.y(), c.z() - 1));
    }

    private String nicknameOf(String clientId) {
        return nicknames.getOrDefault(clientId, clientId);
    }

    /** Random adjective × noun nickname, unique among online users. */
    private String assignNickname(String clientId) {
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        String base = NICK_ADJECTIVES[0] + NICK_NOUNS[0];
        for (int i = 0; i < 20; i++) {
            base = NICK_ADJECTIVES[rnd.nextInt(NICK_ADJECTIVES.length)]
                    + NICK_NOUNS[rnd.nextInt(NICK_NOUNS.length)];
            if (!nicknames.containsValue(base)) {
                return base;
            }
        }
        for (int i = 0; i < 50; i++) {
            String cand = base + (10 + rnd.nextInt(90));
            if (!nicknames.containsValue(cand)) {
                return cand;
            }
        }
        return base + "-" + clientId.substring(2, 6); // practically unreachable
    }

    private static boolean hasControlChar(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                return true;
            }
        }
        return false;
    }

    private List<Map<String, Object>> waitingList() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (String id : queue) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("clientId", id);
            m.put("nickname", nicknameOf(id));
            list.add(m);
        }
        return list;
    }

    private List<Map<String, Object>> placingList() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map.Entry<String, Long> e : placing.entrySet()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("clientId", e.getKey());
            m.put("nickname", nicknameOf(e.getKey()));
            m.put("deadline", e.getValue());
            m.put("pendingCount", pendingCount(e.getKey()));
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
        for (Block b : pending.values()) {
            arr.add(blockNode(b));
        }
        root.set("config", mapper.valueToTree(configMap()));
        ObjectNode me = root.putObject("me");
        me.put("clientId", clientId);
        me.put("nickname", nicknameOf(clientId));
        me.put("state", placing.containsKey(clientId) ? "placing"
                : queue.contains(clientId) ? "queued" : "watching");
        root.put("online", connected.size());
        return root.toString();
    }

    private String queueStateJson() {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "queue_state");
        ArrayNode waiting = root.putArray("waiting");
        for (String id : queue) {
            ObjectNode w = waiting.addObject();
            w.put("clientId", id);
            w.put("nickname", nicknameOf(id));
        }
        ArrayNode placingArr = root.putArray("placing");
        for (Map.Entry<String, Long> e : placing.entrySet()) {
            ObjectNode p = placingArr.addObject();
            p.put("clientId", e.getKey());
            p.put("nickname", nicknameOf(e.getKey()));
            p.put("deadline", e.getValue());
            p.put("pendingCount", pendingCount(e.getKey()));
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
            p.put("nickname", nicknameOf(e.getKey()));
            p.put("secondsLeft", Math.max(0, (int) Math.ceil((e.getValue() - now) / 1000.0)));
            p.put("pendingCount", pendingCount(e.getKey()));
        }
        return root.toString();
    }

    private String turnGrantedJson(long deadline) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "turn_granted");
        root.put("deadline", deadline);
        root.put("blocksPerTurn", props.getBlocksPerTurn());
        return root.toString();
    }

    private String turnReleasedJson(String reason, int cleared) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "turn_released");
        root.put("reason", reason);
        if (cleared > 0) {
            root.put("cleared", cleared);
        }
        return root.toString();
    }

    private String blockPlacedJson(Block b) {
        ObjectNode root = blockNode(b);
        root.put("type", "block_placed");
        return root.toString();
    }

    private String blockMovedJson(Coord from, Coord to, Block block) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "block_moved");
        ObjectNode f = root.putObject("from");
        f.put("x", from.x());
        f.put("y", from.y());
        f.put("z", from.z());
        ObjectNode t = root.putObject("to");
        t.put("x", to.x());
        t.put("y", to.y());
        t.put("z", to.z());
        root.put("by", block.by());
        root.put("byId", block.byId());
        return root.toString();
    }

    private String blockRemovedJson(Coord c, String reason) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "block_removed");
        root.put("x", c.x());
        root.put("y", c.y());
        root.put("z", c.z());
        root.put("reason", reason);
        return root.toString();
    }

    private String blocksConfirmedJson(List<Block> confirmed) {
        ObjectNode root = mapper.createObjectNode();
        root.put("type", "blocks_confirmed");
        ArrayNode arr = root.putArray("blocks");
        for (Block b : confirmed) {
            arr.add(blockNode(b));
        }
        return root.toString();
    }

    private ObjectNode blockNode(Block b) {
        ObjectNode n = mapper.createObjectNode();
        n.put("x", b.x());
        n.put("y", b.y());
        n.put("z", b.z());
        n.put("material", b.material());
        n.put("color", b.color());
        n.put("by", b.by());
        n.put("placedAt", b.placedAt()); // null while pending (Jackson writes null)
        n.put("pending", b.pending());
        n.put("byId", b.byId());
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
