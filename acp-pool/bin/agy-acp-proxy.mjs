#!/usr/bin/env node
/**
 * agy-acp-proxy —— 在 `agy acp` 的 stdio 上做一层最小代理。
 *
 * 背景：`agy --remote-agent acp` 会忽略 --model，会话固定 gemini-4-neon-high；
 * 唯一可切换的方式是会话级 `session/set_config_option`，但上游 dsh-subagent-acp
 * 客户端不发这个请求。本代理在 `session/new` 响应返回前插入一次切换，再原样放行。
 *
 * 用法：ACP_MODEL=claude-sonnet-5-5 agy-acp-proxy.mjs --remote-agent acp --sandbox
 * 未设 ACP_MODEL 时退化为纯透传（不解析、不改动任何字节）。
 */
import { spawn } from 'node:child_process'

const AGY_BIN = process.env.ACP_AGY_BIN || '/root/.local/bin/agy'
const model = String(process.env.ACP_MODEL || '').trim()
const args = process.argv.slice(2)

const child = spawn(AGY_BIN, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })

function wireSignals() {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      try { child.kill(sig) } catch { /* already gone */ }
    })
  }
  child.on('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  child.on('error', (error) => {
    process.stderr.write(`[agy-acp-proxy] 启动 ${AGY_BIN} 失败：${error.message}\n`)
    process.exit(127)
  })
}

if (model === '') {
  // 纯透传：不解析、不缓冲，字节级等价于直接跑 agy。
  wireSignals()
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
} else {
  let switched = false
  let heldSessionResponse
  let pending = []
  let requestId
  let buffer = ''

  const write = (text) => { process.stdout.write(text) }
  const send = (payload) => { child.stdin.write(`${JSON.stringify(payload)}\n`) }

  const flushHeld = () => {
    if (heldSessionResponse !== undefined) {
      write(`${heldSessionResponse}\n`)
      heldSessionResponse = undefined
    }
    for (const line of pending) write(`${line}\n`)
    pending = []
  }

  const handleLine = (line) => {
    if (switched) {
      write(`${line}\n`)
      return
    }
    let message
    try {
      message = JSON.parse(line)
    } catch {
      write(`${line}\n`)
      return
    }
    // 扣留 session/new 响应：带上 sessionId 的那条
    if (heldSessionResponse === undefined && message.result !== null && typeof message.result === 'object'
      && typeof message.result.sessionId === 'string') {
      heldSessionResponse = line
      requestId = `agy-acp-proxy-set-model-${process.pid}`
      send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/set_config_option',
        params: { sessionId: message.result.sessionId, configId: 'model', value: model },
      })
      return
    }
    // 切换请求的应答：无论成败都要放行原 session/new，避免客户端卡死
    if (requestId !== undefined && message.id === requestId) {
      if (message.error !== undefined) {
        process.stderr.write(`[agy-acp-proxy] 切换 ${model} 失败（保留服务端默认模型）：${JSON.stringify(message.error)}\n`)
      } else {
        process.stderr.write(`[agy-acp-proxy] 会话模型已切换到 ${model}\n`)
      }
      switched = true
      flushHeld()
      if (buffer !== '') { write(buffer); buffer = '' }
      return
    }
    if (heldSessionResponse !== undefined) {
      pending.push(line)
      return
    }
    write(`${line}\n`)
  }

  wireSignals()
  process.stdin.pipe(child.stdin)
  child.stdout.on('data', (chunk) => {
    if (switched) {
      write(chunk.toString('utf8'))
      return
    }
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      handleLine(line)
    }
  })
}
