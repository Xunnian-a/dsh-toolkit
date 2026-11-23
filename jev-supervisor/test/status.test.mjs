import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectTasks, formatTasks } from '../lib/status.js'

function workspaceWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'jev-status-'))
  mkdirSync(join(root, 'var'), { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(root, 'var', name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return root
}

test('按 updated_at 倒序，坏文件跳过', () => {
  const root = workspaceWith({
    'a.wal.json': { task_id: 'a', state: 'COMPLETED', round: 1, max_rounds: 3, updated_at: '2026-11-18T01:00:00+00:00', artifacts: { route: 'agy', commit: 'abcdef1234' } },
    'b.wal.json': { task_id: 'b', state: 'WAITING', round: 2, max_rounds: 3, updated_at: '2026-11-18T02:00:00+00:00', last_validation: { passed: false } },
    'broken.wal.json': '{not json',
    'ignore.json': { task_id: 'c' },
  })
  try {
    const tasks = collectTasks(root, { limit: 10 })
    assert.deepEqual(tasks.map((task) => task.taskId), ['b', 'a'])
    assert.equal(tasks[0].state, 'WAITING')
    assert.equal(tasks[1].commit, 'abcdef1234')
    assert.equal(tasks[1].route, 'agy')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('taskId 过滤与 limit 生效', () => {
  const root = workspaceWith({
    'a.wal.json': { task_id: 'a', state: 'COMPLETED', updated_at: '2026-11-18T01:00:00+00:00' },
    'b.wal.json': { task_id: 'b', state: 'WAITING', updated_at: '2026-11-18T02:00:00+00:00' },
  })
  try {
    assert.deepEqual(collectTasks(root, { taskId: 'a' }).map((task) => task.taskId), ['a'])
    assert.equal(collectTasks(root, { limit: 1 }).length, 1)
    assert.equal(collectTasks(root, { limit: 0 }).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('空目录与卡片文案', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-status-empty-'))
  try {
    assert.deepEqual(collectTasks(root), [])
    assert.match(formatTasks([]), /没有找到任务/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const text = formatTasks([{ taskId: 'x', state: 'COMPLETED', round: 1, maxRounds: 3, route: 'agy', commit: 'abcdef1', updatedAt: '2026-11-18T01:00:00+00:00' }])
  assert.match(text, /✅ x/)
  assert.match(text, /route agy/)
  assert.match(text, /1\/3 轮/)
})
