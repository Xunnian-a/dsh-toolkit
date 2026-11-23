/** 从运行中的 DSH 拿到 defineTool（插件在 profile 外，裸导入解析不到）。 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FALLBACK_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh'

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
        /* 继续向上 */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return existsSync(join(FALLBACK_ROOT, 'package.json')) ? FALLBACK_ROOT : undefined
}

let cached

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
  if (root === undefined) throw new Error(`[dsh-acp-pool] 定位不到 DSH 安装目录：${firstError?.message ?? firstError}`)
  const path = join(root, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  if (!existsSync(path)) throw new Error(`[dsh-acp-pool] 缺少内部模块：${path}`)
  const module = await import(pathToFileURL(path).href)
  if (typeof module.defineTool !== 'function') throw new Error('[dsh-acp-pool] dsh-tools 未导出 defineTool，内部契约可能已变化')
  return (cached = module.defineTool)
}
