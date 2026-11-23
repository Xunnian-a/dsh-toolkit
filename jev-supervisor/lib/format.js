/** 输出整形：解析 CLI 的 JSON、裁剪验证证据、生成工具卡片文案。 */
import { readFileSync } from 'node:fs'

/** 从混合输出里尽力解析出 JSON 对象（部分子命令会在 JSON 后追加 "wrote ..."）。 */
export function parseJsonObject(text) {
  const value = String(text ?? '').trim()
  if (value === '') return undefined
  const candidates = [value]
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 试下一个候选 */
    }
  }
  return undefined
}

/** 读 JSON 文件；不存在/坏文件返回 undefined。 */
export function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 把 /usage summary 的 groups 字典转成数组，并保留原始百分比/重置时间。 */
export function normalizeGroups(summary) {
  const groups = summary?.groups
  if (groups === null || typeof groups !== 'object' || Array.isArray(groups)) return []
  return Object.entries(groups).map(([name, value]) => ({
    name,
    weeklyPct: typeof value?.weekly_pct === 'number' ? value.weekly_pct : null,
    weeklyReset: typeof value?.weekly_reset === 'string' ? value.weekly_reset : null,
    fiveHourPct: typeof value?.five_hour_pct === 'number' ? value.five_hour_pct : null,
    fiveHourReset: typeof value?.five_hour_reset === 'string' ? value.five_hour_reset : null,
  }))
}

/** cooldowns 是 {window: untilIso}。 */
export function normalizeCooldowns(summary) {
  const cooldowns = summary?.cooldowns
  if (cooldowns === null || typeof cooldowns !== 'object' || Array.isArray(cooldowns)) return []
  return Object.entries(cooldowns).map(([window, until]) => ({ window, until: String(until) }))
}

export function formatUsageSummary(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return ''
  return groups
    .map((group) => {
      const five = group.fiveHourPct === null ? '?' : `${group.fiveHourPct}%`
      const weekly = group.weeklyPct === null ? '?' : `${group.weeklyPct}%`
      return `${group.name}: 5h ${five} / 周 ${weekly}`
    })
    .join('；')
}

/** 只保留排错需要的验证证据，避免把几千字塞回模型上下文。 */
export function trimValidation(validation) {
  if (validation === null || typeof validation !== 'object' || Array.isArray(validation)) return undefined
  const trim = (value, limit = 800) => {
    const text = String(value ?? '')
    return text.length <= limit ? text : `…${text.slice(-limit)}`
  }
  return {
    passed: validation.passed === true,
    ...(typeof validation.command === 'string' ? { command: validation.command } : {}),
    ...(typeof validation.exit_code === 'number' ? { exitCode: validation.exit_code } : {}),
    ...(validation.exit_code === null ? { exitCode: null } : {}),
    ...(typeof validation.stdout === 'string' && validation.stdout !== '' ? { stdoutTail: trim(validation.stdout) } : {}),
    ...(typeof validation.stderr === 'string' && validation.stderr !== '' ? { stderrTail: trim(validation.stderr) } : {}),
    ...(Array.isArray(validation.results) ? { results: validation.results.slice(0, 10) } : {}),
  }
}

const ICONS = {
  COMPLETED: '✅',
  WAITING: '⏸️',
  FAILED: '❌',
  CANCELLED: '⛔',
}

/** 一行任务结果，给工具卡片用。 */
export function formatRunSummary(value) {
  const parts = [`${ICONS[value.state] ?? '•'} ${value.state}`, `task ${value.taskId}`]
  if (value.route) parts.push(`route ${value.route}${value.routeSource ? ` (${value.routeSource})` : ''}`)
  if (value.rounds > 0) parts.push(`round ${value.rounds}`)
  if (value.branch) parts.push(`branch ${value.branch}`)
  if (value.commit) parts.push(`commit ${String(value.commit).slice(0, 8)}`)
  if (value.reason) parts.push(`reason ${value.reason}`)
  if (Number.isFinite(value.durationMs)) parts.push(`${(value.durationMs / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

/** 一行计划结果；test_commands 可能非常长，卡片里只留缩写。 */
export function formatPlanSummary(value) {
  const commands = Array.isArray(value.testCommands) ? value.testCommands : []
  const first = commands[0] === undefined
    ? ''
    : `；test_commands[0]：${commands[0].length <= 120 ? commands[0] : `${commands[0].slice(0, 120)}…`}`
  const more = commands.length > 1 ? `（共 ${commands.length} 条）` : ''
  return `已生成 ${value.taskPath}（task ${value.taskId}，允许文件 ${value.allowedFilesRegex}）${first}${more}`
}

/** 一行额度结果。 */
export function formatQuotaSummary(value) {
  if (value.ok !== true) return `额度查询失败：${value.error ?? '未知错误'}`
  const cooldowns = Array.isArray(value.cooldowns) && value.cooldowns.length > 0
    ? `；冷却中：${value.cooldowns.map((item) => `${item.window}→${item.until}`).join(', ')}`
    : ''
  return `${value.summary}${cooldowns}`
}

/** 一行路由结果。 */
export function formatRouteSummary(value) {
  const confidence = typeof value.confidence === 'number' ? ` · conf ${value.confidence.toFixed(2)}` : ''
  return `Jev 建议 ${value.route} · collab ${value.needCollab ? 'yes' : 'no'} · ${value.source}${confidence}`
}
