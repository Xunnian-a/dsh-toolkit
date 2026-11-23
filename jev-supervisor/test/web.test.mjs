import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createStatusHandler } from '../lib/web.js'

function fakeResponse() {
  let status
  let body = ''
  return {
    writeHead(code) { status = code },
    end(chunk) { body = chunk },
    get status() { return status },
    get json() { return JSON.parse(body) },
  }
}

function workspaceWithTask() {
  const root = mkdtempSync(join(tmpdir(), 'jev-web-'))
  mkdirSync(join(root, 'var'), { recursive: true })
  writeFileSync(join(root, 'var', 't.wal.json'), JSON.stringify({
    task_id: 't',
    state: 'WAITING',
    round: 1,
    max_rounds: 3,
    updated_at: '2026-11-18T01:00:00+00:00',
    artifacts: { route: 'agy' },
  }))
  return root
}

test('GET 返回任务与额度', async () => {
  const root = workspaceWithTask()
  try {
    const handler = createStatusHandler({
      connection: { requestRejection: () => undefined },
      workspace: root,
      readQuota: async () => ({ capturedAt: '2026-11-18T00:00:00Z', groups: [{ name: 'Gemini Models', fiveHourPct: 99 }] }),
    })
    const response = fakeResponse()
    await handler({ method: 'GET', headers: {} }, response)
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.tasks.length, 1)
    assert.equal(response.json.tasks[0].taskId, 't')
    assert.equal(response.json.quota.groups[0].fiveHourPct, 99)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('鉴权拒绝与方法拒绝', async () => {
  const denied = createStatusHandler({
    connection: { requestRejection: () => 403 },
    workspace: '/tmp',
    readQuota: async () => undefined,
  })
  const response = fakeResponse()
  await denied({ method: 'GET', headers: {} }, response)
  assert.equal(response.status, 403)

  const root = workspaceWithTask()
  try {
    const handler = createStatusHandler({
      connection: { requestRejection: () => undefined },
      workspace: root,
      readQuota: async () => undefined,
    })
    const other = fakeResponse()
    await handler({ method: 'POST', headers: {} }, other)
    assert.equal(other.status, 405)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
