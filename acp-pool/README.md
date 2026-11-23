# dsh-acp-pool

在 DSH 运行时注册**多个 ACP provider**（一个模型一个），并提供一个自动选模型的委派工具 `acp_delegate`——不用每次手动挑 `subagent_*` 工具，也不受「一个 provider 只能绑一个模型」的限制。

## 为什么需要它

`agy` 的模型只能在子命令**之前**指定：

```bash
agy --model gemini-3.8-flash-medium acp --sandbox   # ✅
agy acp --sandbox --model gemini-3.8-flash-medium   # ❌ 只打印 usage
```

而 `@deepseek-ai/dsh-subagent-acp` 一个实例只注册一个 provider（命令 + args 固定）。想在 DSH 里按任务换模型，就得有多个 provider。本插件对每个模型调一次上游 ACP 插件的 `apply()`（`ctx.plugin`），复用它的实现，不修改也不依赖上游导出内部类。

## 工具：`acp_delegate`

把一件自包含任务交给外部 ACP 模型：

| 参数 | 说明 |
|---|---|
| `description` | 3–5 个词的短标题（必填） |
| `prompt` | 完整任务；子 agent 看不到本对话（必填） |
| `cwd` | 可选工作目录，省略则继承当前目录 |
| `provider` | 可选，强制指定 provider（跳过自动选择与 Jev 门禁） |
| `profile` | `auto`（默认）/ `fast`（优先 gemini）/ `strong`（优先 claude） |

返回 `kind: activation` + `subagentId`；子 agent 完成后会发通知。若开了 Jev 门禁且 Jev 判 `dsh`，返回 `kind: advice`（不启动子 agent）。

### 自动选择规则

1. **任务类型**：`auto` 下，prompt 长度 ≥800 字符或命中「综述/论文/研究/长文/报告/架构/设计/重构/分析/评审/review/design/analysis…」→ 优先 `claude`（强模型），否则优先 `gemini`（快模型）。
2. **额度**：调 `python3 -m jev_supervisor usage --json`（默认缓存 10 分钟），把「Gemini Models」「Claude and GPT models」两组映射成可用性；优先组不可用就切另一组，两组都不可用直接报错。
3. **显式覆盖**：`provider` 参数 > `profile` > 自动规则。

### 可选 Jev 门禁

`gate: jev`（可选；示例配置里默认 `off`）时，委派前先调 `jev_supervisor route`：

- `route=dsh` 且置信度 ≥ `gateConfidence`（默认 0.5）→ 返回建议（`kind: advice`），不启动子 agent；
- `route=agy/both` 或 Jev 失败 → 继续委派，并在 `warnings` 里标注路由结果；
- 实测每次门禁只多 1–1.8 秒；10 个委派样本里 2 个高置信 `dsh` 任务被拦（code_fix 0.70、code_flag 0.79），其余放行。

## 配置

```yaml
- insert:
    - id: dsh-acp-pool
      name: 'dsh-acp-pool'
      config:
        profileDir: /root/.dsh/profiles/web   # 用来解析 dsh-subagent-acp
        command: /root/.local/bin/agy
        permission: allow                     # allow / reject
        acpArgs: ['--sandbox']                # 追加在 acp 之后
        gate: off                             # off（默认）/ jev
        gateConfidence: 0.5                   # route=dsh 且 conf ≥ 该值才拦截
        quota:
          enabled: true
          workspace: /root/dsh-projects/jev-supervisor
          python: python3
          ttlSec: 600
          timeoutSec: 25
        providers:
          - name: acp-gemini-flash
            model: gemini-3.8-flash-medium
            group: gemini                   # 省略时按模型名推断
          - name: acp-claude-sonnet
            model: claude-sonnet-4-6
            group: claude
          - name: acp-gemini-review
            model: gemini-3.8-flash-medium
            group: gemini
            permission: reject              # 只读审查；显式指定才用
```

`permission` 可以按 provider 覆盖全局值。`permission: reject` 的 provider 不参与 auto 选择（避免普通任务被拒写），只能在 `acp_delegate` 里显式传 `provider`。

可用模型：

```bash
/root/.local/bin/agy models
```

加模型 = 往 `providers` 加一行 → 对本插件 disable → enable（不用重启 DSH）。

## 约束与安全

- 最多 8 个 provider；provider 名 / 工具名重复、保留名、未知模型未给 group 都会在加载阶段报错。
- `permission: allow` 表示自动同意 ACP 子进程的权限请求；`reject` 会让 agy 的工具模式拿不到结果。
- provider 注册是 effect-scoped 的：本插件 disable/卸载时，provider 与 `acp_delegate` 一起消失。
- 额度缓存与 Jev 门禁都会失败降级：查询失败只告警，不阻塞委派。

## 安装

```bash
# 插件管理者里安装：
link:/root/dsh-projects/dsh-acp-pool
```

## 测试

```bash
cd /root/dsh-projects/dsh-acp-pool
node --test test/*.test.mjs
```

覆盖：配置校验（分组/重名/上限/gate/quota）、`--model` 位置、模块解析、任务类型选组、额度降级、Jev 门禁阈值。

## 已知限制

- 每个 ACP 子 agent 是独立进程，启动有开销（Gemini 首次可能 3 分钟），适合整任务，不适合高频小调用。
- Gemini 侧偶发 `503 No capacity available`（实际请求名是 `gemini-3.8-flash-high`），agy 会内部重试，可能拖到 3 分钟；急用可 `profile: strong`。
- 模型 id 随 agy 版本变化，以 `agy models` 为准；写错会在子 agent 结果里报错。
- 额度判断只看 5 小时/周剩余百分比，不按单次 token 计费。
