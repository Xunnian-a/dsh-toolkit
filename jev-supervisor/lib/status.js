/** 任务状态汇总：读 jev-supervisor 的 WAL（var/*.wal.json），给对话里的状态卡片用。 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ICONS = {
  COMPLETED: '✅',
  WAITING: '⏸️',
  FAILED: '❌',
  CANCELLED: '⛔',
  EXECUTING: '▶️',
  VALIDATING: '🧪',
  REVIEWING: '🔍',
  REVISING: '🔁',
  PLANNING: '🗺️',
  ANALYZING: '🔎',
  CREATED: '🆕',
}

/** 读取并按 updated_at 倒序返回任务摘要；坏文件跳过，不抛错。 */
export function collectTasks(workspace, { limit = 10, taskId } = {}) {
  const dir = join(workspace, 'var')
  if (!existsSync(dir)) return []
  const tasks = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.wal.json')) continue
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object' || typeof record.task_id !== 'string') continue
    if (taskId !== undefined && record.task_id !== taskId) continue
    tasks.push({
      taskId: record.task_id,
      state: typeof record.state === 'string' ? record.state : 'UNKNOWN',
      round: Number.isInteger(record.round) ? record.round : 0,
      maxRounds: Number.isInteger(record.max_rounds) ? record.max_rounds : 3,
      ...(typeof record.artifacts?.route === 'string' ? { route: record.artifacts.route } : {}),
      ...(typeof record.branch === 'string' ? { branch: record.branch } : {}),
      ...(typeof record.updated_at === 'string' ? { updatedAt: record.updated_at } : {}),
      ...(record.last_validation?.passed === true ? { passed: true } : {}),
      ...(typeof record.artifacts?.commit === 'string' ? { commit: record.artifacts.commit } : {}),
      ...(typeof record.goal === 'string' ? { goal: record.goal } : {}),
    })
  }
  tasks.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
  return limit > 0 ? tasks.slice(0, limit) : tasks
}

/** 多行卡片文案。 */
export function formatTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return '没有找到任务（var/*.wal.json）'
  return tasks.map((task) => {
    const parts = [`${ICONS[task.state] ?? '•'} ${task.taskId}`, task.state]
    if (task.route !== undefined) parts.push(`route ${task.route}`)
    parts.push(`${task.round}/${task.maxRounds} 轮`)
    if (task.commit !== undefined) parts.push(String(task.commit).slice(0, 7))
    if (task.updatedAt !== undefined) parts.push(task.updatedAt)
    return parts.join(' · ')
  }).join('\n')
}
