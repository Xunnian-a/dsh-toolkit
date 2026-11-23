/**
 * 从运行中的 DSH 进程里借出工具 SDK（defineTool）。
 *
 * 插件装在 profile 目录之外（link:），不能假设 npm 解析能从插件目录找到
 * @deepseek-ai/dsh-tools，所以按「先试裸导入 → 再从 DSH 安装目录按绝对路径导入」
 * 的顺序拿。路径推导方式与 dsh-dual-mirror 的适配层一致。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TESTED = Object.freeze({ min: '0.2.2-rc.1', maxExclusive: '0.4.0' })

const FALLBACK_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh'

/** 定位 DSH 安装根目录：环境变量 → 从 argv[1]（bin.js）向上找包名 → 已知默认路径。 */
export function resolveDshRoot({ argv1 = process.argv[1], env = process.env } = {}) {
  const fromEnv = env.DSH_INSTALL_ROOT
  if (fromEnv !== undefined && existsSync(join(fromEnv, 'package.json'))) return fromEnv

  let dir = argv1 === undefined ? undefined : dirname(argv1)
  while (dir !== undefined && dir !== '/' && dir !== '') {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        if (JSON.parse(readFileSync(pkgPath, 'utf8'))?.name === '@deepseek-ai/dsh') return dir
      } catch {
        /* 坏的 package.json 继续向上找 */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return existsSync(join(FALLBACK_ROOT, 'package.json')) ? FALLBACK_ROOT : undefined
}

export function readDshVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** 粗粒度版本比较，够用来提示「没测过这个版本」。 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? ''))
    return match === null ? undefined : { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === undefined || right === undefined) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  if (left.pre === undefined && right.pre === undefined) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre === right.pre ? 0 : left.pre < right.pre ? -1 : 1
}

let cached

/** 取 defineTool；失败时抛带原因的错误（插件加载失败，不会拖垮整个 profile）。 */
export async function loadDefineTool({ root = resolveDshRoot() } = {}) {
  if (cached !== undefined) return cached

  let firstError
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    if (typeof module.defineTool === 'function') return (cached = module.defineTool)
    firstError = new Error('@deepseek-ai/dsh-tools 没有导出 defineTool')
  } catch (error) {
    firstError = error
  }

  if (root === undefined) {
    throw new Error(`[dsh-jev-supervisor] 定位不到 DSH 安装目录：${firstError instanceof Error ? firstError.message : String(firstError)}`)
  }
  const path = join(root, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  if (!existsSync(path)) {
    throw new Error(`[dsh-jev-supervisor] DSH ${readDshVersion(root) ?? '?'} 缺少内部模块 dsh-tools：${path}`)
  }
  const module = await import(pathToFileURL(path).href)
  if (typeof module.defineTool !== 'function') {
    throw new Error('[dsh-jev-supervisor] dsh-tools 未导出 defineTool，内部契约可能已变化')
  }
  return (cached = module.defineTool)
}
