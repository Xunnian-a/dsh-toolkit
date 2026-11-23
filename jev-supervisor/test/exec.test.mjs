import assert from 'node:assert/strict'
import test from 'node:test'

import { abortError, runProcess } from '../lib/exec.js'

test('捕获 stdout / stderr / 退出码', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
  })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.ok(result.durationMs >= 0)
})

test('按字节上限截断 stdout', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(5000))"],
    limits: { stdout: 100, stderr: 100 },
  })
  assert.equal(result.stdoutTruncated, true)
  assert.equal(Buffer.byteLength(result.stdout), 100)
})

test('超时会杀进程并标记 timedOut', async () => {
  const started = Date.now()
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 300,
  })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 5000, '超时后应立即返回')
})

test('abort signal 会取消子进程', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 10_000,
    signal: controller.signal,
  })
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
})

test('已取消的 signal 直接抛 AbortError', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => runProcess({ command: process.execPath, args: ['-e', '0'], signal: controller.signal }),
    (error) => error.name === 'AbortError',
  )
  assert.equal(abortError().name, 'AbortError')
})

test('启动失败返回 spawnError 而不是抛错', async () => {
  const result = await runProcess({ command: 'definitely-not-a-real-command-xyz' })
  assert.equal(result.spawnError?.code, 'ENOENT')
  assert.equal(result.code, null)
})
