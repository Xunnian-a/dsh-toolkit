/** 从 profile 解析并导入 @deepseek-ai/dsh-subagent-acp。 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadAcpModule({ profileDir }) {
  const manifest = join(profileDir, 'package.json')
  if (!existsSync(manifest)) throw new Error(`[dsh-acp-pool] profileDir 下找不到 package.json：${manifest}`)
  let path
  try {
    path = createRequire(manifest).resolve('@deepseek-ai/dsh-subagent-acp')
  } catch (error) {
    throw new Error(`[dsh-acp-pool] 在 ${profileDir} 下解析不到 @deepseek-ai/dsh-subagent-acp（${error.message}）`)
  }
  const module = await import(pathToFileURL(path).href)
  if (typeof module.apply !== 'function') {
    throw new Error('[dsh-acp-pool] dsh-subagent-acp 未导出 apply，内部契约可能已变化')
  }
  return module
}
