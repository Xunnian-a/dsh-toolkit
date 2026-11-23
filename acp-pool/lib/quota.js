/** 额度读取：调 jev-supervisor 的 usage 子命令，内存缓存 TTL。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function createQuotaReader(config, logger) {
  let cache = { at: 0, summary: undefined }
  return async function read() {
    if (!config.enabled) return undefined
    const now = Date.now()
    const ttl = (cache.summary === undefined ? 60 : config.ttlSec) * 1000
    if (cache.at !== 0 && now - cache.at < ttl) return cache.summary
    try {
      const { stdout } = await execFileAsync(config.python, ['-m', 'jev_supervisor', 'usage', '--json'], {
        cwd: config.workspace,
        timeout: config.timeoutSec * 1000,
        maxBuffer: 1 << 20,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      const summary = JSON.parse(stdout)
      if (summary === null || typeof summary !== 'object' || typeof summary.error === 'string') {
        throw new Error(summary?.error ?? 'usage 输出不是对象')
      }
      cache = { at: now, summary }
      return summary
    } catch (error) {
      const detail = error?.stdout ? String(error.stdout).slice(0, 300) : error?.message
      logger.warn?.(`[dsh-acp-pool] 额度查询失败，本次按任务类型选择：${detail}`)
      cache = { at: now, summary: undefined }
      return undefined
    }
  }
}
