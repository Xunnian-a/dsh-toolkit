/**
 * dsh-jev-supervisor — 把 jev-supervisor 的 CLI 注册成 5 个 DSH 工具：
 *
 *   jev_supervisor_usage   官方 /usage 额度快照（只读，约 6 秒）
 *   jev_supervisor_route   一次真实 Jev 路由（这件事该 DSH 还是 agy 主导）
 *   jev_supervisor_plan    让 headless DSH 读仓库、产出 task.json（规划）
 *   jev_supervisor_run     跑完整 supervisor：Jev 路由 → agy patch / DSH 执行 → 验证 → 提交
 *   jev_supervisor_status  最近任务状态卡片（读 WAL，只读）
 *
 * 安全边界：所有路径必须落在 workspace / allowedRoots 内；子进程带超时与取消、
 * 输出有上限；任务只能在 task.json 的 allowed_files_regex 范围内改文件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { buildPlanArgs, buildRouteArgs, buildRunArgs, RUN_MODES } from './args.js'
import { normalizeConfig } from './config.js'
import { abortError, runProcess, tailOf } from './exec.js'
import {
  formatPlanSummary,
  formatQuotaSummary,
  formatRouteSummary,
  formatRunSummary,
  formatUsageSummary,
  normalizeCooldowns,
  normalizeGroups,
  parseJsonObject,
  readJsonFile,
  trimValidation,
} from './format.js'
import { assertUnderRoots, resolveExistingInWorkspace, resolveInWorkspace } from './paths.js'
import { compareVersions, loadDefineTool, readDshVersion, resolveDshRoot, TESTED } from './sdk.js'
import { collectTasks, formatTasks } from './status.js'
import { createStatusHandler, STATUS_ROUTE } from './web.js'

export const name = 'dsh-jev-supervisor'
export const inject = ['tools', 'webServer', 'connection']

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TASK_MAX_BYTES = 1_000_000

const RUN_MODE_DESCRIPTION = 'real = 真实调用（会消耗额度/时间）；mock = 本地假实现，不联网'

/** 工具输出必须是对象根 schema；把属性表包成 defineTool 需要的形式。 */
function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, properties }
}

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const defineTool = await loadDefineTool()
  const logger = ctx.logger ?? console

  const dshRoot = resolveDshRoot()
  const version = dshRoot === undefined ? undefined : readDshVersion(dshRoot)
  if (version !== undefined && compareVersions(version, TESTED.maxExclusive) >= 0) {
    logger.warn?.(`[dsh-jev-supervisor] DSH ${version} 高于已实测上限 ${TESTED.maxExclusive}，内部契约可能已变化`)
  }

  /** 运行 `python3 -m jev_supervisor <argv>`；超时/取消会杀整个进程组。 */
  async function runCli(argv, { timeoutMs, signal, label }) {
    const result = await runProcess({
      command: config.python,
      args: ['-m', 'jev_supervisor', ...argv],
      cwd: config.workspace,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      timeoutMs,
      limits: { stdout: config.maxOutputBytes, stderr: 65536 },
      signal,
    })
    if (result.aborted) throw abortError()
    if (result.spawnError !== undefined) {
      throw new Error(`无法启动 ${config.python}（${label}）：${result.spawnError.message}`)
    }
    if (result.timedOut) {
      throw new Error(
        `jev_supervisor ${label} 超时（${Math.round(timeoutMs / 1000)}s），已终止子进程。`
        + (result.stderr.trim() === '' ? '' : `\nstderr 尾：${tailOf(result.stderr)}`),
      )
    }
    return result
  }

  /** 子命令退出但没有给出 JSON：把两路输出的尾巴带进错误里。 */
  function outputError(label, proc) {
    const lines = [`jev_supervisor ${label} 没有返回 JSON（exit=${proc.code ?? 'null'}）`]
    if (proc.stdout.trim() !== '') lines.push(`stdout 尾：${tailOf(proc.stdout)}`)
    if (proc.stderr.trim() !== '') lines.push(`stderr 尾：${tailOf(proc.stderr)}`)
    return new Error(lines.join('\n'))
  }

  function readTaskSpec(taskAbs) {
    const raw = readFileSync(taskAbs, 'utf8')
    if (raw.length > TASK_MAX_BYTES) throw new Error(`task.json 过大（>${TASK_MAX_BYTES} 字节）：${taskAbs}`)
    let data
    try {
      data = JSON.parse(raw)
    } catch (error) {
      throw new Error(`task.json 不是合法 JSON：${error.message}`)
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('task.json 必须是 JSON 对象')
    for (const key of ['task_id', 'goal', 'repo', 'allowed_files_regex', 'test_commands']) {
      if (!(key in data)) throw new Error(`task.json 缺少字段 ${key}`)
    }
    if (!TASK_ID.test(String(data.task_id))) {
      throw new Error(`task_id 只允许字母数字和 ._-（≤64），收到：${JSON.stringify(data.task_id)}`)
    }
    if (!Array.isArray(data.test_commands) || data.test_commands.length === 0
      || !data.test_commands.every((item) => typeof item === 'string' && item.trim() !== '')) {
      throw new Error('task.test_commands 必须是非空字符串数组')
    }
    return data
  }

  /** 仓库必须存在、且落在允许的根目录内。相对路径按 workspace 解析。 */
  function assertRepo(repo, label = 'task.repo') {
    if (typeof repo !== 'string' || repo.trim() === '') throw new Error(`${label} 不能为空`)
    const target = isAbsolute(repo) ? resolve(repo) : resolve(config.workspace, repo)
    const real = assertUnderRoots(config.allowedRoots, target, label)
    if (!existsSync(real)) throw new Error(`${label} 不存在：${real}`)
    return real
  }

  function clampTimeout(value, fallback) {
    const timeoutSec = value ?? fallback
    if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > config.maxTimeoutSec) {
      throw new Error(`timeoutSec 必须是 10–${config.maxTimeoutSec} 的整数，收到：${JSON.stringify(value)}`)
    }
    return timeoutSec
  }

  // ---------------------------------------------------------------- usage
  ctx.tools.register(defineTool({
    name: 'jev_supervisor_usage',
    description: '查询 Antigravity 官方额度（agy -p "/usage"）：Gemini / Claude 的 5 小时与周百分比、重置时间、冷却表。只读，约 6 秒，不消耗 agy 额度。',
    parameters: {},
    output: {
      schema: objectSchema({
        ok: { type: 'boolean', required: true },
        capturedAt: { type: 'string' },
        groups: { type: 'json', description: '数组：{name, weeklyPct, weeklyReset, fiveHourPct, fiveHourReset}' },
        cooldowns: { type: 'json', description: '数组：{window, until}' },
        error: { type: 'string' },
        summary: { type: 'string', required: true },
        durationMs: { type: 'integer', required: true },
      }),
      render: (_args, value) => [{ type: 'text', text: formatQuotaSummary(value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 150_000,
    async execute(_args, exec) {
      const startedAt = Date.now()
      const proc = await runCli(['usage', '--json'], { timeoutMs: 120_000, signal: exec.signal, label: 'usage' })
      const data = parseJsonObject(proc.stdout)
      if (data === undefined) throw outputError('usage', proc)

      const groups = normalizeGroups(data)
      const cooldowns = normalizeCooldowns(data)
      const error = typeof data.error === 'string' && data.error !== '' ? data.error : undefined
      const result = {
        ok: error === undefined,
        summary: error === undefined ? formatUsageSummary(groups) : `额度查询失败：${error}`,
        durationMs: Date.now() - startedAt,
      }
      if (error !== undefined) result.error = error
      if (typeof data.captured_at === 'string') result.capturedAt = data.captured_at
      if (groups.length > 0) result.groups = groups
      if (cooldowns.length > 0) result.cooldowns = cooldowns
      logger.info?.(`[dsh-jev-supervisor] usage ok=${result.ok} (${result.durationMs}ms)`)
      return result
    },
  }))

  // ---------------------------------------------------------------- route
  ctx.tools.register(defineTool({
    name: 'jev_supervisor_route',
    description: '让真实 Jev 判断一件事该由谁主导（route=dsh / agy / both），并给出 need_collab、deterministic 与置信度。约 2–7 秒。只问决策，不执行任务，不消耗 agy 额度。',
    parameters: {
      goal: { type: 'string', required: true, description: '任务目标（自然语言，越具体越好）。' },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: '可选约束，例如「只改 calc.py」「不要动公共接口」。最多 20 条。',
      },
      repo: { type: 'string', description: '可选仓库路径（仅用于构造 spec，不会发送给 Jev）。默认 "."。' },
    },
    output: {
      schema: objectSchema({
        route: { type: 'string', required: true },
        needCollab: { type: 'boolean', required: true },
        deterministic: { type: 'boolean', required: true },
        confidence: { type: 'number' },
        source: { type: 'string', required: true },
        warnings: { type: 'array', items: { type: 'string' } },
        durationMs: { type: 'integer', required: true },
      }),
      render: (_args, value) => [{ type: 'text', text: formatRouteSummary(value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 240_000,
    async execute(args, exec) {
      const startedAt = Date.now()
      const argv = buildRouteArgs({
        goal: args.goal,
        constraints: args.constraints ?? [],
        repo: typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo : '.',
      })
      const proc = await runCli(argv, { timeoutMs: 180_000, signal: exec.signal, label: 'route' })
      const data = parseJsonObject(proc.stdout)
      if (data === undefined) throw outputError('route', proc)

      const warnings = []
      if (typeof data.error === 'string' && data.error !== '') {
        warnings.push(`Jev 调用失败，已降级为规则：${data.error}`)
      }
      const confidence = typeof data.confidence === 'number' ? data.confidence : undefined
      if (confidence !== undefined && confidence < 0.5) {
        warnings.push(`Jev 置信度偏低（${confidence.toFixed(2)}），不要仅凭它自动派 agy，建议人工或按规则复核`)
      }
      const result = {
        route: String(data.route ?? 'unknown'),
        needCollab: data.need_collab === true,
        deterministic: data.deterministic === true,
        source: String(data.source ?? 'jev'),
        durationMs: Date.now() - startedAt,
      }
      if (confidence !== undefined) result.confidence = confidence
      if (warnings.length > 0) result.warnings = warnings
      logger.info?.(`[dsh-jev-supervisor] route=${result.route} source=${result.source} (${result.durationMs}ms)`)
      return result
    },
  }))

  // ----------------------------------------------------------------- plan
  ctx.tools.register(defineTool({
    name: 'jev_supervisor_plan',
    description:
      '让 headless DSH 读仓库并产出一份 supervisor 可执行的 task.json（allowed_files_regex / test_commands / constraints / approach）。'
      + '会真实调用一次 DSH 模型，通常 30–90 秒；产出的 test_commands 需要人工核对（本机可能没有 pytest 等命令）。',
    parameters: {
      goal: { type: 'string', required: true, description: '要完成的目标。' },
      repo: { type: 'string', required: true, description: '仓库路径（相对 workspace 或绝对路径，必须存在于 allowedRoots 内）。' },
      taskId: { type: 'string', description: '任务 id（默认 "task"；只允许字母数字和 ._-）。' },
      out: { type: 'string', description: '输出 task.json 路径（相对 workspace；默认 var/<taskId>.json）。' },
      maxRounds: { type: 'integer', description: '最大返工轮数（默认 3）。' },
      timeoutSec: { type: 'integer', description: '超时秒数（默认 600）。' },
    },
    output: {
      schema: objectSchema({
        taskPath: { type: 'string', required: true },
        taskId: { type: 'string', required: true },
        goal: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        allowedFilesRegex: { type: 'string', required: true },
        testCommands: { type: 'array', items: { type: 'string' }, required: true },
        constraints: { type: 'array', items: { type: 'string' } },
        approach: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        durationMs: { type: 'integer', required: true },
      }),
      render: (_args, value) => [{ type: 'text', text: formatPlanSummary(value) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 900_000,
    async execute(args, exec) {
      const startedAt = Date.now()
      const repoAbs = assertRepo(args.repo, 'repo')
      const taskId = typeof args.taskId === 'string' && args.taskId.trim() !== '' ? args.taskId.trim() : 'task'
      if (!TASK_ID.test(taskId)) {
        throw new Error(`taskId 只允许字母数字和 ._-（≤64），收到：${JSON.stringify(args.taskId)}`)
      }
      const outAbs = args.out === undefined || args.out === ''
        ? join(config.workspace, 'var', `${taskId}.json`)
        : resolveInWorkspace(config.workspace, args.out, 'out')
      const timeoutSec = clampTimeout(args.timeoutSec, 600)

      const argv = buildPlanArgs({
        goal: args.goal,
        repo: repoAbs,
        taskId,
        out: outAbs,
        maxRounds: args.maxRounds ?? 3,
        dshProfile: config.dshProfile,
      })
      const proc = await runCli(argv, { timeoutMs: timeoutSec * 1000, signal: exec.signal, label: 'dsh-plan' })

      const spec = readJsonFile(outAbs) ?? parseJsonObject(proc.stdout)
      if (spec === undefined) throw outputError('dsh-plan', proc)
      if (!existsSync(outAbs)) {
        throw new Error(`dsh-plan 退出码 ${proc.code ?? 'null'}，但没有写出 ${outAbs}；stderr 尾：${tailOf(proc.stderr)}`)
      }

      const result = {
        taskPath: outAbs,
        taskId: String(spec.task_id ?? taskId),
        goal: String(spec.goal ?? args.goal),
        repo: String(spec.repo ?? repoAbs),
        allowedFilesRegex: String(spec.allowed_files_regex ?? ''),
        testCommands: Array.isArray(spec.test_commands) ? spec.test_commands.map(String) : [],
        durationMs: Date.now() - startedAt,
      }
      if (Array.isArray(spec.constraints) && spec.constraints.length > 0) result.constraints = spec.constraints.map(String)
      if (typeof spec.approach === 'string' && spec.approach !== '') result.approach = spec.approach
      logger.info?.(`[dsh-jev-supervisor] plan wrote ${outAbs} (${result.durationMs}ms)`)
      return result
    },
  }))

  // ------------------------------------------------------------------ run
  ctx.tools.register(defineTool({
    name: 'jev_supervisor_run',
    description:
      '把 task.json 交给 jev-supervisor 跑完整闭环：状态机 → Jev 路由（dsh/agy/both）→ agy 产出 patch 或 headless DSH 执行 → scratch 内跑测试 → 通过后提交到任务分支。'
      + '真实模式会写仓库分支并提交；agy=real 会消耗 agy 额度（单次约 30–60 秒），dshExec=real 会再启动一次 headless DSH 模型。'
      + '失败进入 WAITING 时 WAL 会保留，重跑同一 task 会从 WAL 恢复。',
    parameters: {
      taskPath: { type: 'string', required: true, description: 'task.json 路径（相对 workspace 或绝对路径，必须在 workspace 内）。' },
      jev: { type: 'string', enum: RUN_MODES.jev, default: 'real', description: `路由来源。${RUN_MODE_DESCRIPTION}` },
      agy: { type: 'string', enum: RUN_MODES.agy, default: 'real', description: `Antigravity patch 来源；tool = 让 agy 在 scratch 里直接用工具改文件（不内联，更贵）。${RUN_MODE_DESCRIPTION}` },
      quota: { type: 'string', enum: RUN_MODES.quota, default: 'real', description: `额度检查。${RUN_MODE_DESCRIPTION}` },
      dshExec: { type: 'string', enum: RUN_MODES.dshExec, default: 'real', description: `路由到 dsh 时的执行器。${RUN_MODE_DESCRIPTION}` },
      primary: {
        type: 'string',
        enum: RUN_MODES.primary,
        default: 'auto',
        description: '强制主执行方；dsh = 只修，both = 双 Agent 并行出候选，review 场景用 dsh。',
      },
      reviewer: {
        type: 'string',
        enum: RUN_MODES.reviewer,
        default: 'none',
        description: 'none = 只做硬验证；dsh / agy = 再让对应 reviewer 审 patched scratch；both = 两者都要通过。',
      },
      requireReviewer: {
        type: 'boolean',
        description: 'reviewer 报错时视为不通过（默认 fail-open，按硬验证结果放行）。',
      },
      measureQuota: { type: 'boolean', description: '在每轮前后强制刷新 /usage（更慢，但能记下额度变化）。' },
      agyMaxFiles: { type: 'integer', description: '内联给 agy 的文件数上限（默认 20）。' },
      agyMaxBytes: { type: 'integer', description: '内联给 agy 的字节上限（默认 60000）。' },
      agyModel: { type: 'string', description: '可选：传给 agy -p 的模型。' },
      timeoutSec: { type: 'integer', description: '超时秒数（默认取插件配置，420）。' },
    },
    output: {
      schema: objectSchema({
        state: { type: 'string', required: true },
        taskId: { type: 'string', required: true },
        route: { type: 'string' },
        routeSource: { type: 'string' },
        rounds: { type: 'integer' },
        branch: { type: 'string' },
        commit: { type: 'string' },
        reason: { type: 'string' },
        validation: { type: 'json', description: '{passed, command?, exitCode?, stdoutTail?, stderrTail?, results?}' },
        blackboard: { type: 'string' },
        wal: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        durationMs: { type: 'integer', required: true },
      }),
      render: (_args, value) => [{ type: 'text', text: formatRunSummary(value) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: (config.maxTimeoutSec + 120) * 1000,
    async execute(args, exec) {
      const startedAt = Date.now()
      const taskAbs = resolveExistingInWorkspace(config.workspace, args.taskPath, 'taskPath')
      const spec = readTaskSpec(taskAbs)
      assertRepo(spec.repo)

      const timeoutSec = clampTimeout(args.timeoutSec, config.timeoutSec)
      const argv = buildRunArgs({
        taskPath: taskAbs,
        jev: args.jev,
        agy: args.agy,
        quota: args.quota,
        dshExec: args.dshExec,
        reviewer: args.reviewer,
        primary: args.primary,
        requireReviewer: args.requireReviewer === true,
        measureQuota: args.measureQuota === true,
        agyMaxFiles: args.agyMaxFiles ?? 20,
        agyMaxBytes: args.agyMaxBytes ?? 60000,
        agyModel: args.agyModel,
        dshProfile: config.dshProfile,
      })
      const proc = await runCli(argv, { timeoutMs: timeoutSec * 1000, signal: exec.signal, label: 'run' })
      const data = parseJsonObject(proc.stdout)
      if (data === undefined) throw outputError('run', proc)

      const taskId = String(spec.task_id)
      if (typeof data.task_id === 'string' && data.task_id !== taskId) {
        logger.warn?.(`[dsh-jev-supervisor] CLI 返回的 task_id（${data.task_id}）与 task.json（${taskId}）不一致`)
      }
      const walPath = join(config.workspace, 'var', `${taskId}.wal.json`)
      const wal = readJsonFile(walPath)

      const warnings = []
      const result = {
        state: typeof data.state === 'string' ? data.state : 'UNKNOWN',
        taskId,
        durationMs: Date.now() - startedAt,
      }
      const route = wal?.artifacts?.route ?? data.route
      if (typeof route === 'string') result.route = route
      if (typeof wal?.artifacts?.route_source === 'string') result.routeSource = wal.artifacts.route_source
      const rounds = Number.isInteger(data.rounds) ? data.rounds : (Number.isInteger(wal?.round) ? wal.round : undefined)
      if (rounds !== undefined) result.rounds = rounds
      const branch = typeof data.branch === 'string' ? data.branch : wal?.branch
      if (typeof branch === 'string') result.branch = branch
      const commit = data.commit ?? wal?.artifacts?.commit
      if (typeof commit === 'string') result.commit = commit
      if (typeof data.reason === 'string') result.reason = data.reason

      const validation = trimValidation(data.validation ?? wal?.last_validation)
      if (validation !== undefined) result.validation = validation

      const blackboardRel = typeof data.blackboard === 'string' && data.blackboard !== ''
        ? data.blackboard
        : `var/${taskId}.blackboard.jsonl`
      result.blackboard = resolve(config.workspace, blackboardRel)
      if (existsSync(walPath)) result.wal = walPath

      if (proc.stdoutTruncated) warnings.push('CLI 输出超过捕获上限，已截断')
      if (!['COMPLETED', 'WAITING', 'FAILED', 'CANCELLED'].includes(result.state)) {
        warnings.push(`未知状态 ${result.state}，请查看黑板：${result.blackboard}`)
      }
      if (proc.code !== 0 && result.state === 'COMPLETED') {
        warnings.push(`CLI 退出码 ${proc.code}，但结果状态是 COMPLETED（请核对 WAL）`)
      }
      if (warnings.length > 0) result.warnings = warnings
      logger.info?.(`[dsh-jev-supervisor] run ${taskId} → ${result.state} (${result.durationMs}ms)`)
      return result
    },
  }))


  // --------------------------------------------------------------- status
  ctx.tools.register(defineTool({
    name: 'jev_supervisor_status',
    description: '列出 jev-supervisor 最近任务状态（读 var/*.wal.json）：state、route、轮次、提交、更新时间；可选附 /usage 额度。只读，不执行任务。',
    parameters: {
      taskId: { type: 'string', description: '可选：只看某个 task_id。' },
      limit: { type: 'integer', description: '最多返回几条（默认 10；0 = 全部，上限 200）。' },
      includeQuota: { type: 'boolean', description: '同时查询官方额度（约 9 秒）。' },
    },
    output: {
      schema: objectSchema({
        tasks: { type: 'json', required: true, description: '数组：{taskId,state,round,maxRounds,route?,branch?,commit?,updatedAt?,passed?,goal?}' },
        count: { type: 'integer', required: true },
        summary: { type: 'string', required: true },
        quota: { type: 'json' },
        durationMs: { type: 'integer', required: true },
        warnings: { type: 'array', items: { type: 'string' } },
      }),
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 150_000,
    async execute(args, exec) {
      const startedAt = Date.now()
      const limit = Number.isInteger(args.limit) ? args.limit : 10
      if (limit < 0 || limit > 200) throw new Error('limit 必须是 0–200 的整数')
      const filter = typeof args.taskId === 'string' && args.taskId.trim() !== '' ? args.taskId.trim() : undefined
      const tasks = collectTasks(config.workspace, { limit, taskId: filter })
      const warnings = []
      const result = { tasks, count: tasks.length, summary: formatTasks(tasks), durationMs: Date.now() - startedAt }

      if (args.includeQuota === true) {
        const proc = await runCli(['usage', '--json'], { timeoutMs: 120_000, signal: exec.signal, label: 'status/usage' })
        const data = parseJsonObject(proc.stdout)
        if (data === undefined) {
          warnings.push('额度查询没有返回 JSON')
        } else {
          const groups = normalizeGroups(data)
          const cooldowns = normalizeCooldowns(data)
          const ok = !(typeof data.error === 'string' && data.error !== '')
          result.quota = { ok, groups, cooldowns }
          if (groups.length > 0) result.summary += `\n额度：${formatUsageSummary(groups)}`
          else if (!ok) warnings.push(`额度查询失败：${String(data.error)}`)
        }
      }

      result.durationMs = Date.now() - startedAt
      if (warnings.length > 0) result.warnings = warnings
      logger.info?.(`[dsh-jev-supervisor] status ${result.count} task(s) (${result.durationMs}ms)`)
      return result
    },
  }))

  // ------------------------------------------------------- web status card
  let quotaCache = { at: 0, value: undefined, ok: false }
  let quotaPending
  async function readQuotaCached() {
    const ttl = quotaCache.ok ? 600_000 : 60_000
    if (Date.now() - quotaCache.at < ttl) return quotaCache.value
    if (quotaPending !== undefined) return quotaPending
    quotaPending = (async () => {
      try {
        const proc = await runCli(['usage', '--json'], { timeoutMs: 120_000, label: 'web status quota' })
        const data = parseJsonObject(proc.stdout)
        const value = data === undefined
          ? undefined
          : { capturedAt: data.captured_at, groups: normalizeGroups(data) }
        quotaCache = { at: Date.now(), value, ok: value !== undefined }
        return value
      } catch {
        quotaCache = { at: Date.now(), value: undefined, ok: false }
        return undefined
      } finally {
        quotaPending = undefined
      }
    })()
    return quotaPending
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_ROUTE,
    handler: createStatusHandler({ connection: ctx.connection, workspace: config.workspace, readQuota: readQuotaCached }),
  }), 'dsh-jev-supervisor: status route')

  logger.info?.(`[dsh-jev-supervisor] 已注册 5 个工具 + ${STATUS_ROUTE}（workspace=${config.workspace}, allowedRoots=${config.allowedRoots.join(',')}）`)
}
