/** jev_supervisor CLI 的参数拼装与枚举校验（纯函数，方便单测）。 */

export const RUN_MODES = Object.freeze({
  jev: ['real', 'mock'],
  agy: ['real', 'mock', 'tool'],
  quota: ['real', 'mock'],
  dshExec: ['real', 'mock'],
  reviewer: ['none', 'dsh', 'agy', 'both'],
  primary: ['auto', 'dsh', 'agy', 'both'],
})

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} 只能是 ${allowed.join(' / ')}，收到：${JSON.stringify(value)}`)
  }
  return value
}

function positiveInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的整数，收到：${JSON.stringify(value)}`)
  }
  return value
}

function nonEmpty(value, name, maxLength = 20000) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} 不能为空`)
  if (value.length > maxLength) throw new Error(`${name} 过长（上限 ${maxLength} 字符）`)
  return value
}

/**
 * jev-supervisor run 的参数。
 * @param {object} input
 * @param {string} input.taskPath 已解析的绝对路径
 */
export function buildRunArgs({
  taskPath,
  jev = 'real',
  agy = 'real',
  quota = 'real',
  dshExec = 'real',
  reviewer = 'none',
  primary = 'auto',
  requireReviewer = false,
  measureQuota = false,
  agyMaxFiles = 20,
  agyMaxBytes = 60000,
  agyModel,
  dshProfile = 'headless',
} = {}) {
  nonEmpty(taskPath, 'taskPath')
  const args = [
    'run',
    '--task', taskPath,
    '--jev', oneOf(jev, RUN_MODES.jev, 'jev'),
    '--agy', oneOf(agy, RUN_MODES.agy, 'agy'),
    '--quota', oneOf(quota, RUN_MODES.quota, 'quota'),
    '--dsh-exec', oneOf(dshExec, RUN_MODES.dshExec, 'dshExec'),
    '--primary', oneOf(primary, RUN_MODES.primary, 'primary'),
    '--reviewer', oneOf(reviewer, RUN_MODES.reviewer, 'reviewer'),
    '--agy-max-files', String(positiveInteger(agyMaxFiles, 'agyMaxFiles', 1, 500)),
    '--agy-max-bytes', String(positiveInteger(agyMaxBytes, 'agyMaxBytes', 1024, 4000000)),
    '--dsh-profile', nonEmpty(dshProfile, 'dshProfile', 100),
    '--json',
  ]
  if (requireReviewer) args.push('--require-reviewer')
  if (measureQuota) args.push('--measure-quota')
  if (agyModel !== undefined && agyModel !== null && agyModel !== '') {
    args.push('--agy-model', nonEmpty(agyModel, 'agyModel', 200))
  }
  return args
}

/** jev-supervisor dsh-plan 的参数。 */
export function buildPlanArgs({
  goal,
  repo,
  taskId = 'task',
  out,
  maxRounds = 3,
  dshProfile = 'headless',
} = {}) {
  return [
    'dsh-plan',
    '--goal', nonEmpty(goal, 'goal'),
    '--repo', nonEmpty(repo, 'repo'),
    '--task-id', nonEmpty(taskId, 'taskId', 64),
    '--out', nonEmpty(out, 'out'),
    '--max-rounds', String(positiveInteger(maxRounds, 'maxRounds', 1, 20)),
    '--dsh-profile', nonEmpty(dshProfile, 'dshProfile', 100),
  ]
}

/** jev-supervisor route 的参数（一次真实 Jev 路由）。 */
export function buildRouteArgs({ goal, constraints = [], repo = '.' } = {}) {
  if (!Array.isArray(constraints) || !constraints.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error('constraints 必须是非空字符串数组')
  }
  if (constraints.length > 20) throw new Error('constraints 最多 20 条')
  const args = ['route', '--goal', nonEmpty(goal, 'goal'), '--repo', nonEmpty(repo, 'repo', 4096)]
  for (const constraint of constraints) args.push('--constraints', constraint)
  return args
}
