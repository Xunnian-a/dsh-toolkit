# dsh-dual-mirror

把「DSH ↔ 外部 agent（Antigravity）」的对话录成当前会话下一条**可浏览的子会话**（只读卡片）。
工具：`mirror_agent_dialog(label, messages[] | transcriptPath, speakers?)`。

## 为什么存在（2026-11-16 事故）

0.1.0 为了省事，把气泡 `append('user/message', …)` 写进**父会话**。工具调用进行中插入消息后，
父会话历史变成 `tool_call → user message → tool_result`，模型接口不接受这个顺序，
该会话**之后每一轮**都请求失败（适配层报 `DeepSeek Messages transport failed`）。

处置与重写原则（用户原话）：

> 「那个插件本身需要重写：它只该往子会话里写，不能往父会话中间插。」

## 新契约：只往子会话里写

| 位置 | 允许写入 | 说明 |
|---|---|---|
| 子会话 | `subagent/descriptor` + 若干 `user/message` | 全部对话内容只落这里，静态记录，没有 agent 运行态 |
| 父会话 | **只有一条** `subagent/catalog` | 官方子会话卡片发现事件；非消息事件，不进模型请求 |

代码里只有一处 `parent.append`，参数是 `'subagent/catalog'`；`lib/mirror.js` 只生成
`user/message` 与 `subagent/descriptor`，不生成任何 `assistant/message`。

## 0.3.0 按外部评审做的修订

| 评审项 | 处理 |
|---|---|
| P0-1 补真实会话回归测试 | `test/verify.mjs [6]`：用真实 `Session` 构造 `user → assistant(tool-call) → tool/call`，插件写入后再补 `tool/result`，断言 `deriveMessages()` 里 tool 紧挨 assistant、catalog 不在消息里；对照用例复现旧写法（中间插 user），断言相邻性失败 |
| P0-2 内容来源不可信 | 新增 `transcriptPath`：从记录文件逐字导入（支持 dual-dialog 的 `## A → B` 分节）；只给 `messages` 时，子会话首条固定写入「✍️ 来源：由模型整理，非逐字记录」 |
| P1-1 内部契约失效半径 | 新增 `lib/adapter.js`：从 `argv[1]`/`DSH_INSTALL_ROOT` 解析 DSH 根目录，不写死 import；启动自检 = 版本区间 + 真实 `Session` 形状探测；失败则**不写会话**，降级导出 Markdown 到 `$DSH_HOME/dual-mirror/exports/` |
| P1-2 头像附件依赖 | 启动时检查两个 attachmentId 是否在附件库；缺失时退化为纯文字（只写名字前缀） |
| P1-3 输入限制与脱敏 | label ≤ 80 字、消息 ≤ 200 条、单条 ≤ 8000 字、总计 ≤ 120k 字；剥控制字符/零宽/双向覆盖字符；落盘前对常见密钥格式脱敏（sk-、ghp_、AWS key、Bearer、私钥块、`api_key=…`） |
| P1-4 事故遗留会话 | 见下文「已经写坏的会话怎么办」 |
| P2 幂等 | 内容指纹（label+来源+发言方+正文）存 `$DSH_HOME/dual-mirror/index.json`；重试命中直接复用，不重复造卡片 |
| P2 去掉死参数 | 工具不再有 `cwd` 参数 |
| P2 catalog 重试 | 父会话 catalog 失败自动重试一次；仍失败则报错并保留已落盘的子会话 |
| P2 close 失败 | 记日志（内容已 flush，读取时持久化层会修复尾部） |
| P2 清理脚本 | `scripts/mirror-sessions.mjs`：只读列出，删除需显式 id + `--yes` |
| P2 发言方名字 | `speakers: {user, assistant}` 可覆盖，默认 DSH / Antigravity |
| P2 措辞 | 「不占 session store」改为「不创建 live Session」 |

## 子会话是怎么写出来的

不新建 live Session、不跑 agent，直接走持久化 seam（content-addressed JSONL）：

```js
const { header, events } = buildMirrorSession({ parentHeader, label, messages, provenance, speakers })
const handle = await ctx.sessionPersistence.create(header)   // header: version 4 / origin 'subagent'
await handle.append(events)                                   // seq 从 0 连续
await handle.flush()
await handle.close()
parent.append('subagent/catalog', { version: 0, childId, childCreatedAt, mode: 'one-shot', label })
```

- 子会话首条事件是 `subagent/descriptor`（`{version: 3, mode: 'one-shot', provider: 'dsh-dual-mirror', label}`）。
  UI 靠这条投影判断「子会话可点开」；缺了它，服务端读子会话会报
  `subagent/catalog-diagnostic: subagent descriptor is unavailable`。
- 落盘位置：`$DSH_HOME/sessions/<encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd`，
  与真实会话同构，但没有 agent、不出现在侧栏。
- 双方消息都用 `user/message`（带 `surfaceOp: 'append'`），靠 32×32 头像 + 名字前缀区分；
  不伪造 `assistant/message` 所需的 turn/step/stream/usage。

## 内容来源与可信度

- `transcriptPath`（推荐）：从记录文件逐字导入，首条气泡写「📄 来源：<相对路径>（从记录文件逐字导入）」。
  文件必须位于会话 cwd 之下，大小 ≤ 2MB。
- `messages`：模型转述，首条气泡写「✍️ 来源：由模型整理，非逐字记录」。长对话可能被截断或改写，
  UI 上的 Antigravity 头像**不代表**逐字原话。

## 降级模式

启动自检不通过（DSH 版本低于 0.2.2-rc.1，或事件形状探测失败）或 `sessionPersistence` 不可用时：
工具照常注册，但**不写任何会话**，改为在 `$DSH_HOME/dual-mirror/exports/` 生成 Markdown，
返回值 `mode: 'export'`，渲染提示导出路径。最坏结果是一份文件，不会污染会话。

## 幂等与清理

- 索引：`$DSH_HOME/dual-mirror/index.json`（原子写，最多保留 200 条）。
- 列出：`node scripts/mirror-sessions.mjs`（可加 `--json`）。
- 删除：`node scripts/mirror-sessions.mjs --remove <childSessionId> --yes`
  （只允许删除本插件登记过的子会话；父会话里的卡片事件不会被改写，UI 可能留一张打不开的卡片）。

## 已经写坏的会话怎么办

症状：某会话每轮失败，适配层报 `DeepSeek Messages transport failed`，其他会话正常。三条路：

1. **回滚备份**：会话目录里若有事故前的 `.bak-*`（本项目修过一次，文件名形如
   `session.v4.jsonl.zstd.bak-clean-*`），停服务后用它覆盖当前文件。
2. **截断修复**：定位事故轮次——最后一个正常 `turn/end` 之后、第一条工具调用中的 `user/message` 之前；
   把日志截断到该边界并保持 seq 连续，再重启服务核对。
3. **新会话迁移**：新开一个会话，把需要的上下文贴过去；旧会话保留只读，不推荐继续用。

修复前先停服务（App「停止 dsh」→ STOPPED），并对会话目录整体备份。

## 验证

```bash
node test/verify.mjs          # 71 项
node scripts/mirror-sessions.mjs
```

`test/verify.mjs` 覆盖：真实 `Session` 构造器接受全部事件、父会话写入边界、catalog schema、
真实 `apply()` 注册、回归（tool_call 与 tool_result 相邻）、输入卫生、记录文件导入、幂等/重试/降级、适配层。

## 已知限制

- 一条子会话一次调用生成（一个卡片一段记录），不支持往同一条追加。
- 卡片 `one-shot`：UI 里只读，不能续聊。
- 没有 token/时长指标（没有真实 agent 活动）。
- 依赖 DSH 内部契约（事件形状、descriptor v3、catalog v0、`sessionPersistence` 服务名）。
  自检能挡住形状变化并降级，但升级后仍需人工确认一次。
- 父会话每次调用会多一条 `subagent/catalog` 事件（唯一的父会话写入）。
- 子会话不进 workspace registry：入口只有父会话卡片；卡片丢了文件就成了孤儿（用清理脚本核对）。


> 注：`test/verify.mjs` 里有两条用例读本机 `~/.dsh` 的头像附件，换机器请改路径或跳过；其余为纯逻辑用例。
