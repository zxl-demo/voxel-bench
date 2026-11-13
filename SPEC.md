# 体素方块世界 — 多语言实现对比规约 v2

同一份业务，用多种语言各实现一遍（先 Java，确认功能后再移植）。本文件是所有语言版本必须遵守的同一份规约，改动规约需同步更新所有已实现版本。

## v2 相对 v1 的改动

- 一回合可连续放置多个方块，数量可配置（默认 5）。
- 放置是「暂存 + 确认」两阶段：本轮放的方块先是待确认状态，可移动、可移除；点确认后才正式落定并结束回合；超时/断线/取消则清除本轮全部待确认方块。
- 每个用户进场时服务端随机分配昵称，可修改；方块记录放置人昵称与放置时间，任何人可查看。
- 渲染要求收紧：6 种材质必须肉眼可区分；方块落在网格格子正中央，不压网格线；预览必须实时反映当前选的材质与颜色；可否放置必须一眼区分。

## 业务

无限大 3D 地图上放置方块。所有人可观看；放置权按排队抢占。

### 世界与方块

- 坐标为整数 `(x, y, z)`，x/z 无界，`y >= 0`。地面是 y=0 平面（只渲染网格，不存为方块）。
- **不许悬空**：放置位置必须满足 `y == 0`（落地面）或 6 邻居（上下左右前后）中至少一个已有方块。服务端强制校验，客户端只做预览提示。
  - 支撑判定中的「已有方块」= 已确认方块 + **自己本轮的待确认方块**。别人本轮的待确认方块只占格子（不能放进同一格），不给别人当支撑——这样超时清理时不会让别人的方块悬空。
- 目标格已有方块（已确认或任何人的待确认）时不可放置。
- 材质 6 种：`grass` 草、`dirt` 泥土、`stone` 石头、`wood` 木头、`glass` 玻璃、`brick` 砖块。
- 颜色 8 种：`red` 红、`orange` 橙、`yellow` 黄、`green` 绿、`blue` 蓝、`purple` 紫、`white` 白、`black` 黑。
- 材质与颜色都随方块存服务端；另存放置人昵称（确认时刻的快照，之后改昵称不追溯）与放置时间（确认时刻的时间戳）。
- v2 状态放内存，服务重启世界清零（后续版本再考虑持久化）。

### 昵称

- 每个连接进场时服务端随机分配一个昵称（如「快乐砖匠」），在线用户之间不重名（冲突时重抽/加后缀）。
- 客户端可发 `rename` 修改昵称：去首尾空白后 1–12 个字符；重名时回 `name_taken`，不生效；非法时回 `name_invalid`。
- 队列、放置者名单、方块归属一律显示昵称，不显示 clientId（clientId 仍保留在协议里做身份标识）。

### 排队与回合

- 每个浏览器连接一个 WebSocket 会话，状态三选一：`watching`（观看，默认）、`queued`（排队中）、`placing`（持有放置权）。
- 抢占：客户端发 `join`。已在队列/持有放置权时忽略；等待人数已达 `queue.max-length` 时回 `queue_full`，不入队；否则入队尾，回排队位置。
- 发放：空闲放置位（持有数 < `placers.max`）且队列非空时，取队首发放放置权，时限 `turn.seconds` 秒（默认 30），向全员广播。
- 放置：持有放置权者发 `place`。服务端校验：①仍持有未过期放置权 ②本轮待确认数 < `turn.blocks-per-turn`（满了回 `quota_exceeded`）③目标格为空 ④不悬空（支撑规则见上）⑤材质/颜色合法。合法则生成一个**待确认方块**、全员广播，放置权**保留**，剩余时间内可继续放/移动/移除/确认；非法只回错误给本人。
- 移动：持有放置权者发 `move`（from → to）。校验：from 必须是自己本轮的待确认方块（否则 `not_pending_owner` / `no_such_block`）；to 须为空格（from 自身格除外）、y >= 0；模拟移动后自己的全部待确认方块仍须都有支撑，否则回 `would_float`。合法则广播 `block_moved`。
- 移除：持有放置权者发 `remove`（x, y, z）。校验同 move 的归属；模拟移除后自己的其余待确认方块仍须都有支撑，否则回 `would_float`。合法则广播 `block_removed`（reason=removed），本轮计数减一。
- 确认：持有放置权者发 `confirm`。自己的全部待确认方块正式落定（放置人=当前昵称，放置时间=确认时刻），广播 `blocks_confirmed`；放置权释放（reason=confirmed），立即发放下一位。待确认数为 0 时确认等价于放弃本轮（直接释放放置权）。
- 取消：持有放置权者发 `cancel`。清除自己本轮全部待确认方块（逐个广播 `block_removed`，reason=cancelled），放置权释放（reason=cancelled），立即发放下一位。
- 超时：服务端每秒扫一次，过期放置权释放并广播（reason=timeout，附 `cleared` = 清除的待确认数），同时清除该用户本轮全部待确认方块（逐个广播 `block_removed`，reason=timeout），立即发放下一位。
- 断线：关闭网页/断开连接即离开队列或释放放置权（关闭网页必须重新排队），并清除该用户本轮全部待确认方块（reason=disconnect），立即发放下一位。
- 所有人（含观看者）实时收到：落块（待确认/确认/移动/移除）、队列变化、放置权发放/释放、倒计时、昵称变更。

### 配置（环境变量/配置文件，改配置重启生效）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `turn.seconds` | 30 | 持有放置权后限时秒数 |
| `turn.blocks-per-turn` | 5 | 一回合最多连续放置的方块数（待确认计数） |
| `placers.max` | 3 | 同时持有放置权的人数 |
| `queue.max-length` | 20 | 排队队列最大长度（等待人数），满了拒绝入队 |

### 协议（WebSocket，JSON，端点 `/ws`）

客户端 → 服务端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `join` | — | 加入排队 |
| `leave` | — | 离开队列（仅排队中有效） |
| `place` | `x, y, z, material, color` | 放置一个待确认方块 |
| `move` | `from: {x,y,z}, to: {x,y,z}` | 移动自己本轮的待确认方块 |
| `remove` | `x, y, z` | 移除自己本轮的待确认方块 |
| `confirm` | — | 确认本轮全部待确认方块并结束回合 |
| `cancel` | — | 清除本轮待确认方块并放弃回合 |
| `rename` | `nickname` | 修改自己的昵称 |

服务端 → 客户端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `init` | `blocks: [{x,y,z,material,color,by,placedAt,pending,byId}]`、`config`、`me: {clientId, nickname, state}`、`online` | 连接后全量同步一次；待确认方块 `pending=true`、`placedAt=null` |
| `block_placed` | `x, y, z, material, color, by, byId, pending: true` | 有人放下待确认方块 |
| `block_moved` | `from: {x,y,z}, to: {x,y,z}, by, byId` | 待确认方块被移动 |
| `block_removed` | `x, y, z, reason: removed \| timeout \| cancelled \| disconnect` | 待确认方块被清除 |
| `blocks_confirmed` | `blocks: [{x,y,z,material,color,by,placedAt}]` | 一批待确认方块正式落定 |
| `queue_state` | `waiting: [{clientId, nickname}]`、`placing: [{clientId, nickname, deadline, pendingCount}]`、`online` | 队列/放置权变化时广播 |
| `turn_granted` | `deadline, blocksPerTurn` | 发给获得放置权者 |
| `turn_released` | `reason: confirmed \| timeout \| cancelled \| disconnect, cleared?` | 放置权释放；`cleared` 为本次清除的待确认数（>0 时附带） |
| `renamed` | `clientId, nickname` | 有人改了昵称（同时会跟一条 queue_state） |
| `error` | `code, message` | 见下 |
| `countdown` | `placing: [{clientId, nickname, secondsLeft, pendingCount}]` | 每秒广播一次 |

错误码：`queue_full` / `not_your_turn` / `cell_occupied` / `floating` / `bad_block` / `quota_exceeded`（本轮已放满）/ `not_pending_owner`（动别人的待确认方块）/ `no_such_block`（目标不是待确认方块）/ `would_float`（移动/移除后会有方块悬空）/ `name_taken` / `name_invalid`。

REST（调试/兜底）：`GET /api/state` 返回方块全量（含 by/placedAt/pending）+ 队列快照 + 配置；`GET /api/config` 返回配置（含 blocksPerTurn）。

### 前端

- Three.js 渲染：地面网格、已放方块、待确认方块（与已确认有明显视觉区分：半透明 + 橙色描边；自己的待确认方块描边会呼吸/脉冲）、幽灵预览块。
- **网格对齐**：方块中心在格子正中央（坐标 x 的方块中心在 x+0.5），落在网格格子里，不压网格线；幽灵预览同样。
- **材质必须肉眼可区分**：每种材质有自己的程序化纹理（草：顶部草绿斑点、侧面泥土带草皮边；泥土：棕色噪点；石头：灰色噪点加裂纹；木头：竖纹木板；玻璃：淡蓝半透明加边框；砖块：砖缝）。纹理以明度图案为主，颜色以乘色方式叠加——换材质和换颜色都要看得出变化。
- **预览实时**：幽灵预览用当前选的材质纹理 + 颜色（半透明）；切换材质/颜色后预览立即变化，无需重新移动鼠标。
- **可否放置一眼区分**：幽灵预览带彩色描边（可放=绿色、不可放=红色）+ 屏幕上常驻一行状态文字（「可放置」/「不可放置：已有方块」/「不可放置：不能悬空」/「不在放置回合」等原因）。非放置回合不显示放置预览。
- 漫游：OrbitControls（左键拖动旋转、滚轮缩放、右键拖动平移）+ 键盘漫游（W/A/S/D 前后左右、Q/E 下降/上升，Shift 加速；方向键平移视角）+ 重置视角按钮。点击与拖动用位移阈值区分（拖动不触发放置）。
- 选格：射线拾取，点已有方块的某个面则瞄准该面外侧相邻格；点地面则瞄准地面格。
- 本轮操作（仅放置回合可见）：「确认放置（n/5）」主按钮、「取消本轮」按钮；右键点（触屏长按）自己本轮的待确认方块可选中（高亮），再左键点目标格移动它，选中时可点「移除选中」删除；Esc、右键点空处或再次右键点它取消选中。左键永远是放置/移动（这样才能点自己待确认方块的顶面往上叠）。放满 5 个时明确提示「已放满，请确认」。
- 超时提醒：倒计时 ≤10 秒时倒计时条变红并脉冲，旁边常驻提醒「还剩 X 秒，超时未确认将清除本次放置的 N 个方块」；超时清除后用 Toast 明确告知清除了几个。
- 方块信息：悬停任意方块显示浮动标签（已确认：放置人昵称 + 放置时间 + 材质/颜色；待确认：「待确认 · 放置人昵称」）；观看/排队状态下点击已确认方块，在面板里固定显示该方块的完整信息（放置人、放置时间、材质、颜色、坐标）。
- 昵称：顶栏显示自己的昵称，点击可修改（输入框，非法/重名时 Toast 提示）；排队与放置者名单显示昵称。
- 面板：材质选择（6）、颜色选择（8）、排队按钮/当前位置、倒计时条、在线人数、当前放置者名单（含每人本轮已放 n/5）。
- WebSocket 地址由页面 URL 推导（兼容 `/` 与 `/voxel/` 等子路径部署，https 下用 wss）。

## Java 版技术选型（v2）

Spring Boot 3.3 + Java 17，`spring-boot-starter-web` + `spring-boot-starter-websocket`（原生 WebSocket Handler，不用 STOMP，保持协议可移植）。前端静态文件放 `src/main/resources/static`，Three.js 本地 vendor（不依赖 CDN）。单 jar，Docker 多阶段构建，部署到 K3s，网关子路径接入。
