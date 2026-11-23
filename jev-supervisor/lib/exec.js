/**
 * 子进程封装：超时、输出上限、可取消（工具调用的 exec.signal），并尽量杀掉整个进程组。
 *
 * 为什么不用 execFile + timeout：supervisor 会再拉起 agy / dsh，只杀直接子进程会把
 * 孙子进程留在后台继续烧额度。这里让子进程自成进程组，超时/取消时向 -pid 发信号。
 */
import { spawn } from 'node:child_process'

const KILL_GRACE_MS = 3000
const DEFAULT_LIMITS = Object.freeze({ stdout: 262144, stderr: 65536 })

/** 工具被取消时抛出的错误（与 DSH 内置工具的 AbortError 约定一致）。 */
export function abortError(message = 'tool call aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function capture(limit) {
  const chunks = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk) {
      if (bytes >= limit) {
        truncated = true
        return
      }
      const room = limit - bytes
      if (chunk.length <= room) {
        chunks.push(chunk)
        bytes += chunk.length
        return
      }
      chunks.push(chunk.subarray(0, room))
      bytes = limit
      truncated = true
    },
    text() {
      return Buffer.concat(chunks).toString('utf8')
    },
    get truncated() {
      return truncated
    },
  }
}

/**
 * 运行一个命令并等它结束。
 *
 * @param {object} options
 * @param {string} options.command 可执行文件
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs] 0 = 不限时
 * @param {{stdout?: number, stderr?: number}} [options.limits] 字节上限
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{
 *   code: number|null, signal: string|null, stdout: string, stderr: string,
 *   stdoutTruncated: boolean, stderrTruncated: boolean,
 *   timedOut: boolean, aborted: boolean, durationMs: number,
 *   spawnError?: NodeJS.ErrnoException,
 * }>}
 */
export async function runProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = 0,
  limits = DEFAULT_LIMITS,
  signal,
} = {}) {
  if (signal?.aborted) throw abortError()
  const startedAt = Date.now()

  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        spawnError: error,
      })
      return
    }

    const stdout = capture(limits.stdout ?? DEFAULT_LIMITS.stdout)
    const stderr = capture(limits.stderr ?? DEFAULT_LIMITS.stderr)
    let timedOut = false
    let aborted = false
    let spawnError
    let deadline
    let killTimer
    let settled = false

    const killTree = (signalName) => {
      const pid = child.pid
      try {
        if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, signalName)
        else child.kill(signalName)
      } catch {
        try {
          child.kill(signalName)
        } catch {
          /* 已经退出 */
        }
      }
    }

    const stop = (reason) => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'abort') aborted = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const onAbort = () => stop('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))

    const finish = (code, signalName) => {
      if (settled) return
      settled = true
      if (deadline !== undefined) clearTimeout(deadline)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        signal: signalName,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        ...(spawnError === undefined ? {} : { spawnError }),
      })
    }

    child.on('error', (error) => {
      spawnError = error
      finish(null, null)
    })
    child.on('close', (code, signalName) => finish(code, signalName))

    if (timeoutMs > 0) {
      deadline = setTimeout(() => stop('timeout'), timeoutMs)
      deadline.unref?.()
    }
  })
}

/** 把命令输出裁成错误消息里可读的尾巴。 */
export function tailOf(text, limit = 1200) {
  const value = String(text ?? '').trim()
  return value.length <= limit ? value : `…${value.slice(-limit)}`
}
