# agy-mux 规格书 v1

> 调度：DeepSeek（调度员/监督者）　　实现：主脑1（Claude Opus 5.5）
> 日期：2026-11-22

## 一、为什么需要它

当前 DSH 的 `dsh-acp-pool` 直接拉起 `agy --model M acp`，每个 provider 绑定一个账号。有三个缺陷：

1. **provider 上限 8 个**（`lib/config.js:129` 硬编码），超了整个插件激活失败。两个账号 × 3 个模型 + 审查 = 7 个，已经贴顶。
2. **选 provider 用 `find` 取第一个匹配**（`lib/select.js`），同组两个账号永远只用到第一个，第二个闲置。
3. **额度检查只查一个账号**：`jev_supervisor/quota.py` 执行 `agy -p /usage` 不设 HOME，只看到 `/root`（主脑1）的额度，主脑2 的额度不可见，耗尽时会把整组判为不可用。

## 二、目标

在 DSH 与 agy 之间加**一层透明 ACP 代理**，对上游伪装成 `agy`：

```
DSH ──spawn──> agy-mux ──spawn──> agy (HOME=账号A)
                    └──spawn──> agy (HOME=账号B)
```

一次性解决上面三个问题：provider 只按模型划分（3 个），账号由 mux 在内部挑；两个账号的额度都查。

## 三、命令行契约（必须与 agy 兼容）

```
agy-mux --model <model-id> acp [--sandbox] [mux 自己的选项]
```

- 上游只会传 `--model M` + `acp` + `--sandbox`（见 `lib/config.js` 的 `buildArgs`）
- mux 自己的选项用 `--mux-` 前缀，避免与 agy 冲突：
  - `--mux-account <id>` 强制指定账号（A/B/auto，默认 auto）
  - `--mux-trace <id>` 调用链标识，写进日志
  - `--mux-log <path>` 额外的 JSONL 日志
  - `--mux-accounts <path>` 账号表路径，默认 `mux.accounts.json`（与 mux 同目录）

## 四、账号表

`mux.accounts.json`（同目录，或 `--mux-accounts` 指定）：

```json
[
  { "id": "main", "home": "/root", "label": "account-a" },
  { "id": "acc3", "home": "/home/account-b", "label": "account-b" }
]
```

启动时读取并校验：`id` 唯一、`home` 存在、`$home/.gemini/antigravity-cli/antigravity-oauth-token` 存在。缺 token 的账号跳过并告警。

## 五、路由策略

1. 启动时读额度缓存（TTL 300 秒）；过期则对每个账号并发执行
   `HOME=<home> agy -p "/usage"`，解析出 Gemini / Claude 两组的剩余百分比。
2. 选账号：
   - 有 `--mux-account` → 直接用
   - 否则按「剩余额度从高到低」排序，取第一个 > 10% 的
   - 相同额度时轮换（round-robin），避免总是压在同一个账号上
3. 解析 `/usage` 输出格式（实际样例）：

```
Gemini Models	Weekly Limit Remaining	100%	2026-11-29T13:05:33Z
Gemini Models	Five Hour Limit Remaining	100%	2026-11-22T18:05:33Z
Claude and GPT models	Weekly Limit Remaining	94%	2026-11-25T13:28:08Z
```

按「组」取百分比：`Gemini Models` → gemini，`Claude and GPT models` → claude，取两者中较小值作为该账号的可用额度分。

## 六、故障转移

- 识别这些信号 → 把该账号标记为冷却 300 秒，换下一个账号**重新建立会话**并重放当前请求：
  - JSON-RPC error 的 message 含 `RESOURCE_EXHAUSTED` / `quota` / `429`
  - `Authentication required`
  - 子进程异常退出且 stderr 命中上述关键词
- 其他错误（参数错、模型不存在等）原样返回给上游，不重试。
- 所有账号都不可用 → 回一个明确的 JSON-RPC error，message 里列出每个账号的失败原因。

## 七、透明性要求

- `initialize`：选账号后把请求转发给该账号的 agy，回包原样返回。
- `session/new`：记录 `sessionId → 账号` 映射。之后同一 `sessionId` 的所有请求**必须发到同一账号**（否则会话状态对不上）。
- `session/prompt`、`session/set_config_option`、`session/update` 通知：全部原样双向透传，不做任何解析改写。
- 客户端断开或 mux 退出时，杀掉所有子进程。

## 八、观测

- stderr 输出人类可读日志，前缀 `[agy-mux]`，每次选账号写一行：
  `[agy-mux] pick account=acc3 model=claude-opus-5-5-high reason=quota(93%>88%)`
- `--mux-log` 指定时，同步写 JSONL：`{ts, trace, event, account, model, sessionId, detail}`

## 九、第一阶段明确不做

- MCP peer 桥（双主脑主动互调）
- 黑板/交接文件系统
- 跨进程会话保活

这些留在 mux 稳定之后再作为第二阶段叠加。

## 十、代码约束

- **只用 Node 内置模块**（`node:child_process`、`node:readline`、`node:fs`、`node:process`），零 npm 依赖。
- Node 22 可直接运行，ESM（`.mjs`）。
- 关键路径带注释，尤其是"为什么同一 sessionId 必须固定账号"这类隐含约束。
- 单测用 mock 的 agy（一个假脚本，读到请求就回固定响应），**不联网、不真调 agy**。

## 十一、交付清单

| 文件 | 职责 |
|---|---|
| `bin/agy-mux.mjs` | 入口：解析 argv、读账号表、拉起/管理子进程、按 sessionId 路由、故障转移 |
| `lib/account-router.mjs` | 纯函数：给定账号表 + 额度快照 + 轮换状态，返回要用的账号 |
| `lib/quota-cache.mjs` | 执行 `/usage`、解析、缓存（TTL）、提供 `snapshot() -> {accountId: score}` |
| `test/agy-mux.test.mjs` | 单测：路由选择、额度解析、冷却转移、sessionId 固定 |

## 十二、验收标准

1. `node --test test/agy-mux.test.mjs` 全绿。
2. 手工命令 `agy-mux --model claude-opus-5-5-high acp` 能被 DSH 正常拉起并完成一次 prompt。
3. 把主脑1 的 token 改成无效值，mux 应自动切到主脑2 并成功返回。
4. `/usage` 解析对上面给出的真实样例输出正确。
