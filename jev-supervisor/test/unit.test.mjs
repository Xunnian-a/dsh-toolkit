import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPlanArgs, buildRouteArgs, buildRunArgs } from '../lib/args.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'
import { normalizeGroups, parseJsonObject, trimValidation } from '../lib/format.js'
import { isInside, resolveExistingInWorkspace, resolveInWorkspace } from '../lib/paths.js'

test('配置：默认值可用', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.workspace, DEFAULT_CONFIG.workspace)
  assert.deepEqual(config.allowedRoots, ['/root/dsh-projects'])
  assert.equal(config.timeoutSec, 420)
  assert.equal(config.dshProfile, 'headless')
})

test('配置：拒绝相对 workspace / 非法根目录 / 倒挂的超时', () => {
  assert.throws(() => normalizeConfig({ workspace: 'relative/dir' }), /绝对路径/)
  assert.throws(() => normalizeConfig({ allowedRoots: [] }), /allowedRoots/)
  assert.throws(() => normalizeConfig({ allowedRoots: ['relative'] }), /allowedRoots/)
  assert.throws(() => normalizeConfig({ timeoutSec: 900, maxTimeoutSec: 600 }), /不能小于/)
  assert.throws(() => normalizeConfig({ timeoutSec: 1 }), /timeoutSec/)
})

test('run 参数：模式、额外观测、JSON 输出', () => {
  const args = buildRunArgs({
    taskPath: '/root/x/task.json',
    jev: 'real',
    agy: 'mock',
    quota: 'real',
    dshExec: 'mock',
    reviewer: 'agy',
    primary: 'dsh',
    requireReviewer: true,
    measureQuota: true,
    agyMaxFiles: 7,
    agyMaxBytes: 1234,
    dshProfile: 'headless',
  })
  assert.deepEqual(args.slice(0, 3), ['run', '--task', '/root/x/task.json'])
  assert.equal(args[args.indexOf('--agy') + 1], 'mock')
  assert.equal(args[args.indexOf('--reviewer') + 1], 'agy')
  assert.equal(args[args.indexOf('--primary') + 1], 'dsh')
  assert.equal(args[args.indexOf('--agy-max-files') + 1], '7')
  assert.ok(args.includes('--measure-quota'))
  assert.ok(args.includes('--require-reviewer'))
  assert.ok(args.includes('--json'))
  assert.throws(() => buildRunArgs({ taskPath: '/x', jev: 'nope' }), /jev/)
  assert.throws(() => buildRunArgs({ taskPath: '/x', reviewer: 'nope' }), /reviewer/)
  assert.throws(() => buildRunArgs({ taskPath: '/x', primary: 'nope' }), /primary/)
  const both = buildRunArgs({ taskPath: '/x', primary: 'both' })
  assert.equal(both[both.indexOf('--primary') + 1], 'both')
  assert.throws(() => buildRunArgs({ taskPath: '/x', agyMaxFiles: 0 }), /agyMaxFiles/)
})

test('plan / route 参数拼接', () => {
  const plan = buildPlanArgs({ goal: 'g', repo: '/r', taskId: 't', out: '/r/out.json' })
  assert.equal(plan[0], 'dsh-plan')
  assert.equal(plan[plan.indexOf('--task-id') + 1], 't')
  assert.equal(plan[plan.indexOf('--max-rounds') + 1], '3')

  const route = buildRouteArgs({ goal: 'g', constraints: ['a', 'b'] })
  assert.equal(route[0], 'route')
  assert.equal(route.filter((item) => item === '--constraints').length, 2)
  assert.throws(() => buildRouteArgs({ goal: '' }), /goal/)
})

test('路径：相对路径按 workspace 解析，越界被拒', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jev-ws-'))
  try {
    assert.equal(resolveInWorkspace(workspace, 'var/x.json'), join(workspace, 'var/x.json'))
    assert.throws(() => resolveInWorkspace(workspace, '../escape.json'), /workspace/)
    assert.throws(() => resolveInWorkspace(workspace, '/etc/passwd'), /workspace/)
    assert.equal(isInside(workspace, join(workspace, 'a/b')), true)
    assert.equal(isInside(workspace, '/etc'), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('路径：符号链接逃逸被拒', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'jev-out-'))
  try {
    const workspace = join(root, 'ws')
    mkdirSync(workspace)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(workspace, 'link'))
    assert.throws(
      () => resolveExistingInWorkspace(workspace, 'link/secret.txt', 'taskPath'),
      /逃出了 workspace/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('输出整形：容忍 JSON 后的附加文本', () => {
  const parsed = parseJsonObject('{"a":1}\nwrote var/x.json\n')
  assert.deepEqual(parsed, { a: 1 })
  assert.equal(parseJsonObject('not json at all'), undefined)
})

test('输出整形：验证证据只留尾巴', () => {
  const trimmed = trimValidation({ passed: false, exit_code: 1, stdout: 'x'.repeat(2000), stderr: 'y'.repeat(2000) })
  assert.equal(trimmed.passed, false)
  assert.equal(trimmed.exitCode, 1)
  assert.ok(trimmed.stdoutTail.length <= 801)
  assert.ok(trimmed.stderrTail.endsWith('y'))
})

test('输出整形：/usage 分组转数组', () => {
  const groups = normalizeGroups({
    groups: { gemini: { weekly_pct: 99, weekly_reset: 'r1', five_hour_pct: 98, five_hour_reset: 'r2' } },
  })
  assert.deepEqual(groups, [{ name: 'gemini', weeklyPct: 99, weeklyReset: 'r1', fiveHourPct: 98, fiveHourReset: 'r2' }])
})
