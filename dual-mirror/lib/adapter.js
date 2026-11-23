/**
 * DSH 适配层：定位已安装的 DSH、读取版本、加载内部模块、做启动自检。
 *
 * 评审 P1-1 的诉求：不要把 `/usr/local/lib/node_modules/...` 写死在一个 import 里；
 * 把所有内部契约集中到这里，带契约版本常量，自检失败时降级（导出 Markdown，不写会话）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 已实测的 DSH 版本区间（硬校验下限，上限只告警）。 */
export const TESTED = Object.freeze({ min: '0.2.2-rc.1', maxExclusive: '0.3.0' })

/** 内部契约版本：会话格式、descriptor、catalog。 */
export const CONTRACT = Object.freeze({ sessionFormat: 4, descriptorVersion: 3, catalogVersion: 0 })

const FALLBACK_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh'

/**
 * 定位 DSH 安装根目录：环境变量 → 从 argv[1]（bin.js）向上找包名 → 已知默认路径。
 *
 * @param {{argv1?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {string|undefined} 绝对路径；找不到返回 undefined
 */
export function resolveDshRoot({ argv1 = process.argv[1], env = process.env } = {}) {
  const fromEnv = env.DSH_INSTALL_ROOT
  if (fromEnv !== undefined && existsSync(join(fromEnv, 'package.json'))) return fromEnv

  let dir = argv1 === undefined ? undefined : dirname(argv1)
  while (dir !== undefined && dir !== '/' && dir !== '') {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg?.name === '@deepseek-ai/dsh') return dir
      } catch { /* 忽略坏的 package.json，继续向上 */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (existsSync(join(FALLBACK_ROOT, 'package.json'))) return FALLBACK_ROOT
  return undefined
}

/** 读取 DSH 版本号。 */
export function readDshVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? ''))
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** 语义化版本比较（只覆盖 DSH 实际用到的 x.y.z[-pre] 形式）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l) ? Number(l) : undefined
    const rn = /^\d+$/.test(r) ? Number(r) : undefined
    if (ln !== undefined && rn !== undefined && ln !== rn) return ln < rn ? -1 : 1
    if (ln !== undefined && rn === undefined) return -1
    if (ln === undefined && rn !== undefined) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * 加载 DSH 的内部模块（dsh-tools 的 defineTool、dsh-session 的 Session）。
 * 全部路径从解析到的 root 推导，避免写死。
 *
 * @param {string} root
 * @returns {Promise<{defineTool: Function, Session: Function}>}
 */
export async function loadDshModules(root) {
  const toolsPath = join(root, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  const sessionPath = join(root, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')
  if (!existsSync(toolsPath) || !existsSync(sessionPath)) {
    throw new Error(`DSH 安装目录缺少预期的内部模块：${toolsPath} / ${sessionPath}`)
  }
  const [tools, session] = await Promise.all([
    import(pathToFileURL(toolsPath).href),
    import(pathToFileURL(sessionPath).href),
  ])
  if (typeof tools.defineTool !== 'function') throw new Error('dsh-tools 未导出 defineTool，内部契约已变化')
  if (typeof session.Session !== 'function') throw new Error('dsh-session 未导出 Session，内部契约已变化')
  return { defineTool: tools.defineTool, Session: session.Session }
}

/**
 * 启动自检：版本区间 + 用真实 Session 构造器 dry-run 一组样例事件（形状探测）。
 * 失败时插件不写会话，降级为导出 Markdown。
 *
 * @param {object} input
 * @param {string} input.root DSH 根目录
 * @param {Function} input.Session dsh-session 的 Session
 * @param {Function} input.probe 形状探针：接收 Session，内部构造样例会话（返回 void，失败抛错）
 * @returns {{ok: boolean, version?: string, warnings: string[], failures: string[]}}
 */
export function runSelfCheck({ root, Session, probe }) {
  const warnings = []
  const failures = []
  const version = readDshVersion(root)
  if (version === undefined) {
    failures.push('无法读取 DSH 版本号')
  } else if (compareVersions(version, TESTED.min) < 0) {
    failures.push(`DSH ${version} 低于已实测下限 ${TESTED.min}`)
  } else if (compareVersions(version, TESTED.maxExclusive) >= 0) {
    warnings.push(`DSH ${version} 高于已实测上限 ${TESTED.maxExclusive}，仅按形状探测结果判断`)
  }
  try {
    probe(Session)
  } catch (error) {
    failures.push(`事件形状探测失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: failures.length === 0, version, warnings, failures }
}
