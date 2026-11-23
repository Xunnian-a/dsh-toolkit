/** dsh-acp-pool 配置：校验、命名、分组、agy 参数拼装（纯函数，便于单测）。 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CONFIG = Object.freeze({
  /** 用来解析 @deepseek-ai/dsh-subagent-acp 的 profile 目录。 */
  profileDir: join(homedir(), '.dsh/profiles/web'),
  /** agy 可执行文件。 */
  command: join(homedir(), '.local/bin/agy'),
  /** ACP 子进程的权限策略。 */
  permission: 'allow',
  /** 追加在 `acp` 子命令之后的参数。 */
  acpArgs: ['--sandbox'],
  /** off = 直接委派；jev = 先问 Jev，route=dsh 且置信度达标时给建议而不是启动子 agent。 */
  gate: 'jev',
  /** 门禁阈值：route=dsh 且 confidence ≥ 该值才拦截。 */
  gateConfidence: 0.5,
  /** 额度感知：调 jev-supervisor 的 usage 子命令，带缓存。 */
  quota: {
    enabled: true,
    workspace: join(homedir(), 'dsh-projects/jev-supervisor'),
    python: 'python3',
    ttlSec: 600,
    timeoutSec: 25,
  },
  providers: [],
})

const NAME_RE = /^[a-z][a-z0-9-]{2,40}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/
const GROUPS = ['gemini', 'claude']

function asStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '' || item.length > 200 || /[\r\n]/.test(item))) {
    throw new Error(`config.${name} 必须是非空字符串数组（每项 ≤200 字符、不含换行）`)
  }
  return [...value]
}

/** 按模型名推断额度组。 */
export function inferGroup(model) {
  if (/^gemini/i.test(model)) return 'gemini'
  if (/^(claude|gpt)/i.test(model)) return 'claude'
  return undefined
}

function normalizeProviderEnv(raw, index) {
  if (raw === undefined) return Object.freeze({})
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`providers[${index}].env 必须是对象（键=环境变量名，值=字符串）`)
  }
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`providers[${index}].env 的键名不合法：${JSON.stringify(key)}`)
    if (typeof value !== 'string' || value.length > 500 || /[\r\n]/.test(value)) {
      throw new Error(`providers[${index}].env.${key} 必须是 ≤500 字符、不含换行的字符串`)
    }
    out[key] = value
  }
  return out
}

function normalizeProvider(raw, index, seen) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`config.providers[${index}] 必须是对象`)
  }
  const name = raw.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`providers[${index}].name 必须是 [a-z][a-z0-9-]{2,40}，收到：${JSON.stringify(name)}`)
  }
  const model = raw.model
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    throw new Error(`providers[${index}].model 不合法，收到：${JSON.stringify(model)}`)
  }
  const group = raw.group ?? inferGroup(model)
  if (!GROUPS.includes(group)) {
    throw new Error(`providers[${index}].group 只能是 gemini / claude（模型名推断不出时需要显式给），收到：${JSON.stringify(group)}`)
  }
  if (seen.names.has(name)) throw new Error(`provider 名重复：${name}`)
  seen.names.add(name)

  const permission = raw.permission
  if (permission !== undefined && permission !== 'allow' && permission !== 'reject') {
    throw new Error(`providers[${index}].permission 只能是 allow / reject，收到：${JSON.stringify(permission)}`)
  }
  const extraArgs = raw.extraArgs === undefined ? [] : asStringArray(raw.extraArgs, `providers[${index}].extraArgs`)
  for (const flag of extraArgs) {
    if (flag === '--model') throw new Error(`providers[${index}].extraArgs 不能自己带 --model（由 model 字段统一生成）`)
  }
  const env = normalizeProviderEnv(raw.env, index)
  return Object.freeze({ name, model, group, permission, extraArgs, env })
}

function normalizeQuota(raw) {
  const input = raw === undefined ? {} : raw
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('config.quota 必须是对象')
  const enabled = input.enabled ?? DEFAULT_CONFIG.quota.enabled
  if (typeof enabled !== 'boolean') throw new Error('config.quota.enabled 必须是布尔值')
  const workspace = input.workspace ?? DEFAULT_CONFIG.quota.workspace
  if (typeof workspace !== 'string' || !workspace.startsWith('/')) throw new Error('config.quota.workspace 必须是绝对路径')
  const python = input.python ?? DEFAULT_CONFIG.quota.python
  if (typeof python !== 'string' || python.trim() === '') throw new Error('config.quota.python 必须是非空字符串')
  const ttlSec = input.ttlSec ?? DEFAULT_CONFIG.quota.ttlSec
  if (!Number.isInteger(ttlSec) || ttlSec < 60 || ttlSec > 3600) throw new Error('config.quota.ttlSec 必须是 60–3600 的整数')
  const timeoutSec = input.timeoutSec ?? DEFAULT_CONFIG.quota.timeoutSec
  if (!Number.isInteger(timeoutSec) || timeoutSec < 5 || timeoutSec > 120) throw new Error('config.quota.timeoutSec 必须是 5–120 的整数')
  return { enabled, workspace, python, ttlSec, timeoutSec }
}

/** 校验并补全配置；非法值在加载阶段直接抛错。 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const profileDir = input.profileDir ?? DEFAULT_CONFIG.profileDir
  if (typeof profileDir !== 'string' || !profileDir.startsWith('/')) throw new Error('config.profileDir 必须是绝对路径')
  const command = input.command ?? DEFAULT_CONFIG.command
  if (typeof command !== 'string' || !command.startsWith('/')) throw new Error('config.command 必须是绝对路径')
  const permission = input.permission ?? DEFAULT_CONFIG.permission
  if (permission !== 'allow' && permission !== 'reject') throw new Error(`config.permission 只能是 allow / reject，收到：${JSON.stringify(permission)}`)
  const acpArgs = input.acpArgs === undefined ? [...DEFAULT_CONFIG.acpArgs] : asStringArray(input.acpArgs, 'acpArgs')
  if (acpArgs.includes('--model')) throw new Error('config.acpArgs 不能包含 --model（模型必须写在 acp 子命令之前）')
  const gate = input.gate ?? DEFAULT_CONFIG.gate
  if (gate !== 'off' && gate !== 'jev') throw new Error(`config.gate 只能是 off / jev，收到：${JSON.stringify(gate)}`)
  const gateConfidence = input.gateConfidence ?? DEFAULT_CONFIG.gateConfidence
  if (typeof gateConfidence !== 'number' || !(gateConfidence >= 0 && gateConfidence <= 1)) {
    throw new Error('config.gateConfidence 必须是 0–1 之间的数字')
  }

  const rawProviders = input.providers ?? DEFAULT_CONFIG.providers
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) throw new Error('config.providers 至少要有 1 个 provider')
  if (rawProviders.length > 8) throw new Error('config.providers 最多 8 个（再多会明显撑大每轮工具表）')
  const seen = { names: new Set() }
  const providers = rawProviders.map((provider, index) => normalizeProvider(provider, index, seen))

  return Object.freeze({
    profileDir,
    command,
    permission,
    acpArgs: Object.freeze(acpArgs),
    gate,
    gateConfidence,
    quota: Object.freeze(normalizeQuota(input.quota)),
    providers: Object.freeze(providers),
  })
}

/** `agy --model M [extraArgs] acp [acpArgs]`（--model 必须在 acp 之前）。 */
export function buildAcpArgs(provider, config) {
  return ['--model', provider.model, ...provider.extraArgs, 'acp', ...config.acpArgs]
}
