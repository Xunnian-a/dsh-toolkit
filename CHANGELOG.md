# Changelog

## v0.1.0 — 2026-11-24

首个公开版本：把四个在 Android 手机上跑 DeepSeek Harness 时写的小工具合成一个仓库。

**新增**

- `dual-mirror/`：DSH 插件，把双 Agent 对话录成子会话卡片，父会话只留一条目录项。离线校验 71 项。
- `acp-pool/`：DSH 插件，把多个模型注册成 ACP provider，`acp_delegate` 按任务类型自动选型；`agy-mux` 按账号剩余额度路由。单测 23 项。
- `jev-supervisor/`：DSH 插件，把外部 `jev-supervisor` CLI 封成 5 个会话内工具（需自备后端）。单测 25 项。
- `adb-autopair/`：无线 ADB 授权掉线后自动重新配对的 Python 脚本（依赖 DSHA 的 `/app/ui` 桥）。

**已知限制**

- `dual-mirror` 有两条用例读本机 `~/.dsh` 的头像附件，换机器需改路径或跳过；
- `jev-supervisor` 的 e2e 需要本地后端，缺失时会跳过；
- `adb-autopair` 的 UI 文案与流程按 DSHA + OriginOS 编写，换 ROM 可能要改。
