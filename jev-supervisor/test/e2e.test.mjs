import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

const WORKSPACE = process.env.JEV_WORKSPACE || join(homedir(), 'dsh-projects/jev-supervisor')
if (!existsSync(WORKSPACE)) {
  console.log(`跳过 e2e：本机没有后端 ${WORKSPACE}（可用 JEV_WORKSPACE 指定）`)
  process.exit(0)
}
const CALC_BUGGY = 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n'
const CALC_FIXED = 'def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n'
const TEST_FILE = [
  'import unittest',
  '',
  'from calc import add, mul',
  '',
  '',
  'class CalcTest(unittest.TestCase):',
  '    def test_add(self):',
  '        self.assertEqual(add(2, 3), 5)',
  '',
  '    def test_mul(self):',
  '        self.assertEqual(mul(2, 3), 6)',
  '',
  '',
  'if __name__ == "__main__":',
  '    unittest.main()',
  '',
].join('\n')

function fakeContext() {
  const tools = []
  return {
    tools,
    ctx: {
      tools: { register: (tool) => tools.push(tool) },
      logger: { info: () => {}, warn: () => {} },
      effect: (fn) => fn(),
      webServer: { register: () => () => {} },
      connection: { requestRejection: () => undefined },
    },
  }
}

async function loadTools(overrides = {}) {
  const { ctx, tools } = fakeContext()
  await apply(ctx, {
    workspace: WORKSPACE,
    allowedRoots: ['/root/dsh-projects', tmpdir()],
    ...overrides,
  })
  return tools
}

function makeRepo(root) {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(join(repo, 'calc.py'), CALC_BUGGY)
  writeFileSync(join(repo, 'tests', '__init__.py'), '')
  writeFileSync(join(repo, 'tests', 'test_calc.py'), TEST_FILE)
  execFileSync('git', ['init', '-b', 'master', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'jev-test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'jev-test'])
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init buggy calc'])
  return repo
}

function writeTask(file, data) {
  mkdirSync(join(WORKSPACE, 'var'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

test('注册 5 个 jev_* 工具', async () => {
  const tools = await loadTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'jev_supervisor_plan',
    'jev_supervisor_route',
    'jev_supervisor_run',
    'jev_supervisor_status',
    'jev_supervisor_usage',
  ])
  const run = tools.find((tool) => tool.name === 'jev_supervisor_run')
  assert.equal(run.parameters.properties.taskPath.type, 'string')
  assert.ok(run.parameters.required.includes('taskPath'))
  assert.equal(run.parameters.properties.agy.enum.includes('mock'), true)
})

test('mock 端到端：run 完成、写分支并提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-e2e-'))
  const repo = makeRepo(root)
  const taskId = `e2e-${process.pid}-${Date.now()}`
  const taskPath = join(WORKSPACE, 'var', `${taskId}.json`)
  writeTask(taskPath, {
    task_id: taskId,
    goal: 'Fix add() so it returns a + b; do not change mul().',
    repo,
    allowed_files_regex: 'calc\\.py',
    test_commands: ['python3 -m unittest discover -s tests -t .'],
    constraints: ['only modify calc.py'],
    mock_patch: { files: [{ path: 'calc.py', content: CALC_FIXED }], notes: 'fix add' },
  })

  try {
    const tools = await loadTools({ allowedRoots: [root] })
    const run = tools.find((tool) => tool.name === 'jev_supervisor_run')
    const controller = new AbortController()
    const result = await run.execute({
      taskPath,
      jev: 'mock',
      agy: 'mock',
      quota: 'mock',
      dshExec: 'mock',
      timeoutSec: 120,
    }, { signal: controller.signal })

    assert.equal(result.state, 'COMPLETED')
    assert.equal(result.taskId, taskId)
    assert.equal(result.route, 'agy')
    assert.equal(result.routeSource, 'rule')
    assert.ok(typeof result.commit === 'string' && result.commit.length >= 7)
    assert.equal(result.validation.passed, true)

    const branch = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim()
    assert.equal(branch, `task/${taskId}`)
    assert.equal(readFileSync(join(repo, 'calc.py'), 'utf8'), CALC_FIXED)
    assert.ok(existsSync(result.blackboard))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(taskPath, { force: true })
    for (const suffix of ['wal.json', 'blackboard.jsonl']) {
      rmSync(join(WORKSPACE, 'var', `${taskId}.${suffix}`), { force: true })
    }
  }
})

test('仓库不在 allowedRoots 内时拒绝执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-root-'))
  const taskId = `reject-${process.pid}-${Date.now()}`
  const taskPath = join(WORKSPACE, 'var', `${taskId}.json`)
  writeTask(taskPath, {
    task_id: taskId,
    goal: 'touch something outside',
    repo: '/etc',
    allowed_files_regex: '.*',
    test_commands: ['true'],
  })

  try {
    const tools = await loadTools({ allowedRoots: [root] })
    const run = tools.find((tool) => tool.name === 'jev_supervisor_run')
    await assert.rejects(
      () => run.execute({ taskPath, jev: 'mock' }, { signal: new AbortController().signal }),
      /根目录/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(taskPath, { force: true })
  }
})

test('taskPath 逃出 workspace 时拒绝执行', async () => {
  const tools = await loadTools()
  const run = tools.find((tool) => tool.name === 'jev_supervisor_run')
  await assert.rejects(
    () => run.execute({ taskPath: '../AGENTS.md' }, { signal: new AbortController().signal }),
    /workspace/,
  )
})
