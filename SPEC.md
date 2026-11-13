# 体素方块世界 — 多语言实现对比规约 v1

同一份业务，用多种语言各实现一遍（先 Java，确认功能后再移植）。本文件是所有语言版本必须遵守的同一份规约，改动规约需同步更新所有已实现版本。

## 业务

无限大 3D 地图上放置方块。所有人可观看；放置权按排队抢占。

### 世界与方块

- 坐标为整数 `(x, y, z)`，x/z 无界，`y >= 0`。地面是 y=0 平面（只渲染网格，不存为方块）。
- **不许悬空**：放置位置必须满足 `y == 0`（落地面）或 6 邻居（上下左右前后）中至少一个已有方块。服务端强制校验，客户端只做预览提示。
- 目标格已有方块时不可放置。
- 材质 6 种：`grass` 草、`dirt` 泥土、`stone` 石头、`wood` 木头、`glass` 玻璃、`brick` 砖块。
- 颜色 8 种：`red` 红、`orange` 橙、`yellow` 黄、`green` 绿、`blue` 蓝、`purple` 紫、`white` 白、`black` 黑。
- 渲染：方块颜色 = 所选颜色；玻璃半透明，其余不透明。材质与颜色都随方块存服务端。
- v1 状态放内存，服务重启世界清零（后续版本再考虑持久化）。

### 排队与回合

- 每个浏览器连接一个 WebSocket 会话，状态三选一：`watching`（观看，默认）、`queued`（排队中）、`placing`（持有放置权）。
- 抢占：客户端发 `join`。已在队列/持有放置权时忽略；等待人数已达 `queue.max-length` 时回 `queue_full`，不入队；否则入队尾，回排队位置。
- 发放：空闲放置位（持有数 < `placers.max`）且队列非空时，取队首发放放置权，时限 `turn.seconds` 秒（默认 30），向全员广播。
- 放置：持有放置权者发 `place`。服务端校验：①仍持有未过期放置权 ②目标格为空 ③不悬空 ④材质/颜色合法。合法则落块、全员广播、该放置权释放（持有者回 `watching`），立即发放下一位；非法则只回错误给本人，放置权保留（剩余时间内可重试）。
- **一回合只放一个方块**。放完或超时后想再放，需重新点排队（不自动重排）。
- 超时：服务端每秒扫一次，过期放置权释放并广播，立即发放下一位。
- 断线：关闭网页/断开连接即离开队列或释放放置权（关闭网页必须重新排队），并立即发放下一位。
- 所有人（含观看者）实时收到：落块、队列变化、放置权发放/释放、倒计时。

### 配置（环境变量/配置文件，改配置重启生效）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `turn.seconds` | 30 | 持有放置权后限时秒数 |
| `placers.max` | 3 | 同时持有放置权的人数 |
| `queue.max-length` | 20 | 排队队列最大长度（等待人数），满了拒绝入队 |

### 协议（WebSocket，JSON，端点 `/ws`）

客户端 → 服务端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `join` | — | 加入排队 |
| `leave` | — | 离开队列（仅排队中有效） |
| `place` | `x, y, z, material, color` | 放置方块 |

服务端 → 客户端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `init` | `blocks: [{x,y,z,material,color}]`、`config`、`me` | 连接后全量同步一次 |
| `block_placed` | `x, y, z, material, color, by` | 有人落块 |
| `queue_state` | `waiting: [clientIds...]`、`placing: [{clientId, deadline}]` | 队列/放置权变化时广播 |
| `turn_granted` | `deadline` | 发给获得放置权者 |
| `turn_released` | `reason: placed \| timeout \| disconnect` | 放置权释放 |
| `error` | `code, message` | `queue_full` / `not_your_turn` / `cell_occupied` / `floating` / `bad_block` |
| `countdown` | `placing: [{clientId, secondsLeft}]` | 每秒广播一次剩余时间（与 queue_state 可二选一实现） |

REST（调试/兜底）：`GET /api/state` 返回方块全量 + 队列快照 + 配置；`GET /api/config` 返回配置。

### 前端

- Three.js 渲染：地面网格、已放方块、幽灵预览块（可放绿/不可放红）。
- 漫游：OrbitControls（左键旋转、滚轮缩放、右键平移）。
- 选格：射线拾取，点已有方块的某个面则瞄准该面外侧相邻格；点地面则瞄准地面格。
- 面板：材质选择（6）、颜色选择（8）、排队按钮/当前位置、倒计时条、在线人数、当前放置者名单。
- 未持有放置权时点击不发 place（按钮与提示置灰）。
- WebSocket 地址由页面 URL 推导（兼容 `/` 与 `/voxel/` 等子路径部署，https 下用 wss）。

## Java 版技术选型（v1）

Spring Boot 3.3 + Java 17，`spring-boot-starter-web` + `spring-boot-starter-websocket`（原生 WebSocket Handler，不用 STOMP，保持协议可移植）。前端静态文件放 `src/main/resources/static`，Three.js 本地 vendor（不依赖 CDN）。单 jar，Docker 多阶段构建，部署到 K3s，网关子路径接入。
