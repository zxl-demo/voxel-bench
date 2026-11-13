# voxel-bench

多人 3D 体素方块放置应用，同一份业务用多种语言各实现一遍，横向对比。

规约见 [SPEC.md](SPEC.md)：无限大 3D 地图、排队抢放置权、30 秒限时、不许悬空、6 种材质 × 8 种颜色、3D 漫游缩放。

## v2 改动（Java 版已实现）

- 一回合可连续放置多个方块（默认 5 个，`VOXEL_BLOCKS_PER_TURN` 可配）。
- 放置改为「暂存 + 确认」两阶段：本轮方块先是待确认状态，可移动、可移除；点确认后落定，超时/取消/断线则清除本轮全部待确认方块。
- 随机昵称（可修改）；方块记录放置人与放置时间，悬停/点击可查看。
- 材质程序化纹理（肉眼可区分）、方块落在格子正中央、幽灵预览实时反映当前材质/颜色、可否放置有描边 + 状态文字区分；WASD/QE 键盘漫游 + 重置视角。

## 实现

| 目录 | 语言/框架 | 状态 |
| --- | --- | --- |
| java/ | Spring Boot 3.3 + Java 17 | ✅ 已实现，待用户确认功能 |
| rust/ | — | 待 Java 版确认后实现 |
| go/ | — | 待 Java 版确认后实现 |
| cpp/ | — | 待 Java 版确认后实现 |
| python/ | — | 待 Java 版确认后实现 |

## 本地运行（Java 版）

```bash
cd java
mvn spring-boot:run
# 打开 http://localhost:8080
```

配置（环境变量）：`VOXEL_TURN_SECONDS`（默认 30）、`VOXEL_BLOCKS_PER_TURN`（默认 5）、`VOXEL_PLACERS_MAX`（默认 3）、`VOXEL_QUEUE_MAX_LENGTH`（默认 20）。

## 部署

```bash
cd java && docker build -t 100.125.54.90:5005/voxel-java:latest . && docker push 100.125.54.90:5005/voxel-java:latest
kubectl apply -f k8s/
```

公网入口：`https://18443-agqwqndnto3jxy6psfynnflee4.instabox.tech/voxel/`（K3s + InstaBox 网关子路径接入）。
