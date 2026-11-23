# dsh-jev-supervisor

把 [`jev-supervisor`](../jev-supervisor)（DSH + Antigravity + Jev 的后端 MVP）注册成 DSH 工具，让 Agent 在会话里直接做「查额度 / 问路由 / 规划 / 跑完整闭环」。

## 工具

| 工具 | 做什么 | 真实调用 | 典型耗时 |
|---|---|---|---|
| `jev_supervisor_usage` | 解析官方 `agy -p "/usage"`：5 小时/周百分比、重置时间、冷却表 | 是（只读，不耗 agy 配额） | ~6–10s |
| `jev_supervisor_route` | 问真实 Jev：这件事该 `dsh` / `agy` / `both` 主导，附 `need_collab`、`deterministic`、置信度 | 是（Jev API） | ~1.5–7s |
| `jev_supervisor_plan` | 让 headless DSH 读仓库，产出 supervisor 可执行的 `task.json` | 是（一次 DSH 模型调用） | 30–90s |
| `jev_supervisor_run` | 跑完整 supervisor：状态机 → Jev 路由 → agy patch / DSH 执行 → scratch 验证 → 提交任务分支 | 取决于模式 | 20s–数分钟 |
| `jev_supervisor_status` | 读 `var/*.wal.json`，列出最近任务状态（state/route/轮次/提交/时间），可附额度 | 只读 | <1s |

`run` 的模式参数（`jev` / `agy` / `quota` / `dshExec`）都支持 `real` / `mock`：

- 默认全部 `real`（会消耗 agy 额度 / DSH 模型调用，并真实写仓库分支）；
- 离线验证链路用 `jev=mock&agy=mock&quota=mock&dshExec=mock`，需要 task.json 里带 `mock_patch`；
- 路由到 `agy` 但 `agy=mock`、或路由到 `dsh` 但 `dshExec=mock` 且没有 `mock_patch` 时，会以验证失败进入 `WAITING`——这是预期行为，不是插件 bug。

另有两条模式参数：

- `primary`：`auto`（默认，按 Jev 路由）/ `dsh` / `agy`。review 场景用 `dsh`，强制 DSH 主修复。
- `reviewer`：`none`（默认）/ `dsh` / `agy` / `both`。`agy` 是只读审查，真实调用约 40–90 秒；`done=false` 的任务停在 `reviewer_rejected`，不提交。

完整示例（DSH 修 + agy 只读审）：

```json
{"taskPath": "demo/task.json", "primary": "dsh", "reviewer": "agy", "dshExec": "real", "agy": "mock"}
```

## 侧边栏状态面板

插件还带一个 Web 客户端面板（`lib/client.js`）：侧边栏会多一个「jev-supervisor」图标，点开是任务状态卡片——读 `var/*.wal.json`，显示 state / route / 轮次 / 提交 / 更新时间，附带额度行，每 10 秒自动刷新。数据来自宿主路由 `GET /api/dsh-jev-supervisor/status`（同一 session 鉴权）。

> 客户端模块在 DSH 启动时加载：第一次装好（或改了 `lib/client.js`）需要**重启一次 DSH**（停止 → 启动）面板才会出现；之后改宿主代码仍可 disable/enable 热生效。

## 安装

### 方式 A：插件管理者（推荐）

在 DSH 的插件管理里安装 `link:/root/dsh-projects/dsh-jev-supervisor`。安装器会写入 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）并应用 bundle patch；没有 HMR 的 profile 需要重启 DSH。

### 方式 B：手动

```bash
cd ~/.dsh/profiles/web
pnpm add link:/root/dsh-projects/dsh-jev-supervisor
```

然后确认 `package.json` 的 `dsh.profile.bundles` 里出现 `dsh-jev-supervisor`，重启 DSH。

> 插件代码在启动时加载；改完 `lib/` 后对插件做一次 disable → enable（或重启）才会生效。

## 配置

`cordis.patch.yml` 里给插入行加 `config`（全部可选）：

```yaml
- insert:
    - id: dsh-jev-supervisor
      name: 'dsh-jev-supervisor'
      config:
        workspace: /root/dsh-projects/jev-supervisor  # python -m jev_supervisor 的工作目录
        python: python3
        allowedRoots: [/root/dsh-projects]            # 任务仓库/规划仓库必须在这里面
        timeoutSec: 420                               # jev_supervisor_run 默认超时
        maxTimeoutSec: 1200                           # 单次调用允许的最大超时
        maxOutputBytes: 262144                        # stdout 捕获上限（超出截断并告警）
        dshProfile: headless                          # plan 内部用的 DSH profile
```

配置非法时插件会在加载阶段直接报错（不会带着坏路径跑一半）。

## 安全边界

- **路径**：`taskPath` 必须落在 `workspace` 内（真实路径再校验一次，防符号链接逃逸）；任务里的 `repo` 和 `plan` 的 `repo` 必须落在 `allowedRoots` 内。
- **任务 id**：只允许 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，避免 WAL/黑板路径被 `../` 带出 `var/`。
- **子进程**：独立进程组，超时/取消（`exec.signal`）时先 SIGTERM 再 SIGKILL 整组，避免 agy / dsh 孙子进程继续跑。
- **输出**：stdout 有字节上限，stderr 只回尾巴；验证证据只保留最后 800 字符，避免把几千字塞回模型上下文。
- **写操作**：`run` 只在 `task.json` 的 `allowed_files_regex` 范围内改文件，先 clone 到 scratch 跑测试，通过后才提交任务分支——这套约束由 jev-supervisor 本身保证，插件只负责不绕过它。

## 测试

```bash
cd /root/dsh-projects/dsh-jev-supervisor
node --test test/*.test.mjs
```

覆盖：子进程超时/取消/截断、配置校验、参数枚举（含 `primary` / `reviewer`）、路径穿越与符号链接逃逸、JSON 容忍解析、mock 端到端（真 git 仓库 + 真 python 子进程 + 提交分支）。共 25 项。

## 已知限制

- `jev_supervisor_run` 会真实写仓库并提交（这是它的目的）；不想动仓库就用 `jev_supervisor_route` 只问决策。
- 大仓库的 agy patch 仍受「内联 ≤20 文件 / 60KB」限制，强检索未做。
- 按次选模型未做：`agyModel` 只对 `agy -p` 有效，走 ACP 时无效。
- `jev_supervisor_plan` 产出的 `test_commands` 由模型生成，运行前要核对（例如本机可能没有 `pytest`）。
