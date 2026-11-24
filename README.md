# dsh-toolkit

![ci](https://github.com/Xunnian-a/dsh-toolkit/actions/workflows/ci.yml/badge.svg)

在 **Android 手机**上跑 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的一组自用工具：把双 Agent 对话留档、把多个大模型接成可自动选型的委派池、把任务监督器封进会话、以及在无线调试掉线时自动重新配对。

这些工具都来自同一个约束：**只有一台手机、一个 proot Ubuntu 容器，没有独立服务器**。能在这种环境里跑通的东西，搬到正常机器上只会更容易。

## 包含什么

| 目录 | 是什么 | 离线校验 |
|---|---|---|
| [`dual-mirror/`](dual-mirror/) | DSH 插件：把双 Agent 对话录成可回看的**子会话卡片**，父会话只留一条目录项 | 71 项 |
| [`acp-pool/`](acp-pool/) | DSH 插件：把多个模型注册成 ACP provider，`acp_delegate` 按任务类型自动选型；`agy-mux` 按账号剩余额度路由 | 23 项 |
| [`jev-supervisor/`](jev-supervisor/) | DSH 插件：把 `jev-supervisor` CLI 封成 5 个会话内工具（**需自备后端**，本仓库不含） | 25 项 |
| [`adb-autopair/`](adb-autopair/) | 无线 ADB 授权掉线后自动重新配对（依赖 DSHA 的 `/app/ui` 桥） | 手动 `--check` |

## 看一眼输出

不想先装？[`examples/sample-export.md`](examples/sample-export.md) 是插件真实导出的样子（由 `renderMarkdownExport` 生成，不是手写）。

## 状态

个人自用，长期跑在一台 vivo / Android 16 手机上。**没有**在更多设备、更多 DSH 版本上验证过；接口或 UI 文案一变，可能需要跟着改。

测试分两类，别混着看：

| 类型 | 例子 | 换了机器会怎样 |
|---|---|---|
| 纯逻辑单测 | acp-pool 的选择/路由/配置；dual-mirror 的会话构造与脱敏 | 直接跑，结果稳定 |
| 依赖本机环境 | dual-mirror 的头像用例（读本机 `~/.dsh`、校验 32×32 附件）；jev-supervisor 的 e2e（需要本地后端） | 可能失败或需要改路径 |

```bash
node test/verify.mjs                 # dual-mirror，71 项
node --test test/*.test.mjs          # acp-pool 23 项 / jev-supervisor 25 项
```

## 快速开始

每个目录都有自己的 README，安装方式写在里面。共同前提：

1. 已经跑起来一套 DSH（桌面或手机容器都行）；
2. 会改 profile 的 `cordis.patch.yml`（每个目录里的 `cordis.patch.yml` 是模板，里面的 `/path/to/...` 要换成你自己的）；
3. Node.js ≥ 20.11（部分脚本用到 `import.meta.dirname`）。

一键跑全部校验（缺 DSH / 缺后端时对应套件会自动跳过）：

```bash
./scripts/test-all.sh
```

## 已知限制

- `jev-supervisor/` 的 e2e 需要本地有后端（本仓库不含）；缺失时**自动跳过**并打一行提示。
- `dual-mirror` 的校验需要本机装有 DSH：解析顺序为 `DSH_INSTALL_ROOT` → 从 argv 向上找 → node 全局目录 → 常见路径；都找不到时**整段跳过**。头像用例在 `~/.dsh` 不存在时也会跳过。
- `adb-autopair` 的 UI 文案与流程是按 DSHA + OriginOS 写的，换 ROM 可能要改常量；配对页仍需人工确认一次。
- 三个插件都假设你已经在用 DSH 的 cordis 插件机制，且**不保证兼容所有 DSH 版本**（开发时基于 0.2.x）。

## 为什么要做这些

- **dual-mirror**：两个模型互相评审时，对话会污染主会话上下文。把正文放进子会话，父会话只留索引——翻不翻由你，上下文不再被塞满。
- **acp-pool**：一个 ACP provider 只能绑一个模型，而不同任务需要的模型不一样（长文/代码/批量）。顺带解决账号问题：两个账号的额度池独立，让路由层按剩余额度现算，而不是写死。
- **jev-supervisor**：把"查额度 / 问路由 / 规划任务 / 跑闭环"从命令行搬进会话，省掉来回切终端。
- **adb-autopair**：手机上的无线调试授权 7 天到期、Wi-Fi 一断就掉。手动重配对每次要一分多钟，交给脚本按 10 分钟巡检。

## English (short)

A small toolkit for running DeepSeek Harness on an Android phone: dual-agent transcript mirroring, a multi-model ACP provider pool with quota-aware routing, a supervisor wrapper, and an auto re-pair tool for wireless ADB. Built under a single-phone constraint; offline checks included (71/23/25). Personal use — expect rough edges.

## License

MIT. See [LICENSE](LICENSE).
