/** 插件配置：全部可被 profile 的 cordis.patch.yml 覆盖。 */
import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CONFIG = Object.freeze({
  /** jev-supervisor 后端 MVP 的目录（python -m jev_supervisor 在这里执行）。 */
  workspace: join(homedir(), 'dsh-projects/jev-supervisor'),
  /** Python 解释器。 */
  python: 'python3',
  /** 允许被任务操作 / 被规划的真实仓库根目录。 */
  allowedRoots: [join(homedir(), 'dsh-projects')],
  /** jev_supervisor_run 的默认超时（秒）。 */
  timeoutSec: 420,
  /** 单次调用允许的最大超时（秒）。 */
  maxTimeoutSec: 1200,
  /** 单次命令 stdout 的捕获上限（字节），超出截断并告警。 */
  maxOutputBytes: 262144,
  /** plan 子命令内部使用的 DSH profile。 */
  dshProfile: 'headless',
})

const INTEGER_FIELDS = [
  ['timeoutSec', 10, 3600],
  ['maxTimeoutSec', 10, 7200],
  ['maxOutputBytes', 4096, 4 * 1024 * 1024],
]

function asInteger(value, name, min, max) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`config.${name} 必须是 ${min}–${max} 的整数，收到：${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 校验并补全配置；非法值直接抛错，让插件在加载阶段就失败（而不是运行到一半才炸）。
 * @param {unknown} raw cordis 传入的配置对象
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const workspace = input.workspace ?? DEFAULT_CONFIG.workspace
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
    throw new Error(`config.workspace 必须是绝对路径，收到：${JSON.stringify(workspace)}`)
  }

  const python = input.python ?? DEFAULT_CONFIG.python
  if (typeof python !== 'string' || python.trim() === '') {
    throw new Error('config.python 必须是非空字符串')
  }

  const roots = input.allowedRoots ?? DEFAULT_CONFIG.allowedRoots
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every((root) => typeof root === 'string' && isAbsolute(root))) {
    throw new Error('config.allowedRoots 必须是非空的绝对路径数组')
  }

  const values = {}
  for (const [name, min, max] of INTEGER_FIELDS) {
    values[name] = asInteger(input[name], name, min, max) ?? DEFAULT_CONFIG[name]
  }
  if (values.maxTimeoutSec < values.timeoutSec) {
    throw new Error(`config.maxTimeoutSec（${values.maxTimeoutSec}）不能小于 config.timeoutSec（${values.timeoutSec}）`)
  }

  const dshProfile = input.dshProfile ?? DEFAULT_CONFIG.dshProfile
  if (typeof dshProfile !== 'string' || dshProfile.trim() === '') {
    throw new Error('config.dshProfile 必须是非空字符串')
  }

  return Object.freeze({
    workspace: resolve(workspace),
    python,
    allowedRoots: roots.map((root) => resolve(root)),
    dshProfile,
    ...values,
  })
}
