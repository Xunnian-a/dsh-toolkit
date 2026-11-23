/** 门禁用：调 jev-supervisor 的 route 子命令，拿到 Jev 的 dsh/agy/both 判断。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function createRouteReader({ python, workspace }) {
  return async function read(goal) {
    try {
      const { stdout } = await execFileAsync(python, ['-m', 'jev_supervisor', 'route', '--goal', goal], {
        cwd: workspace,
        timeout: 60_000,
        maxBuffer: 1 << 20,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      const data = JSON.parse(stdout)
      return data !== null && typeof data === 'object' ? data : undefined
    } catch {
      return undefined
    }
  }
}
