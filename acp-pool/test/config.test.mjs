import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { buildAcpArgs, DEFAULT_CONFIG, inferGroup, normalizeConfig } from '../lib/config.js'
import { loadAcpModule } from '../lib/modules.js'

const PROVIDERS = [
  { name: 'acp-gemini-flash', model: 'gemini-3.8-flash-medium' },
  { name: 'acp-claude-sonnet', model: 'claude-sonnet-4-6' },
]

test('配置：合法配置补全默认值', () => {
  const config = normalizeConfig({ providers: PROVIDERS })
  assert.equal(config.command, DEFAULT_CONFIG.command)
  assert.equal(config.permission, 'allow')
  assert.deepEqual(config.acpArgs, ['--sandbox'])
  assert.equal(config.gate, 'jev')
  assert.equal(config.gateConfidence, 0.5)
  assert.equal(config.quota.enabled, true)
  assert.equal(config.providers.length, 2)
  assert.equal(config.providers[0].group, 'gemini')
  assert.equal(config.providers[1].group, 'claude')
})

test('配置：provider 级 permission 覆盖全局', () => {
  const config = normalizeConfig({
    providers: [
      ...PROVIDERS,
      { name: 'acp-gemini-review', model: 'gemini-3.8-flash-medium', group: 'gemini', permission: 'reject' },
    ],
  })
  assert.equal(config.providers[0].permission, undefined)
  assert.equal(config.providers[2].permission, 'reject')
  assert.throws(() => normalizeConfig({
    providers: [{ name: 'acp-bad', model: 'gemini-3.8-flash-medium', permission: 'maybe' }],
  }), /permission/)
})

test('配置：按模型名推断额度组', () => {
  assert.equal(inferGroup('gemini-3.8-flash-low'), 'gemini')
  assert.equal(inferGroup('claude-opus-4-6-thinking'), 'claude')
  assert.equal(inferGroup('gpt-oss-120b-medium'), 'claude')
  assert.equal(inferGroup('some-other-model'), undefined)
})

test('配置：未知模型必须显式给 group', () => {
  assert.throws(() => normalizeConfig({ providers: [{ name: 'acp-x', model: 'some-model' }] }), /group/)
  const config = normalizeConfig({ providers: [{ name: 'acp-x', model: 'some-model', group: 'claude' }] })
  assert.equal(config.providers[0].group, 'claude')
})

test('配置：provider 至少一个、最多 8 个、名字/模型/重复校验', () => {
  assert.throws(() => normalizeConfig({ providers: [] }), /至少/)
  const many = Array.from({ length: 9 }, (_, index) => ({ name: `acp-${index}`, model: `m-${index}` }))
  assert.throws(() => normalizeConfig({ providers: many }), /最多 8 个/)
  assert.throws(() => normalizeConfig({ providers: [{ name: 'AC P', model: 'm' }] }), /name/)
  assert.throws(() => normalizeConfig({ providers: [{ name: 'acp-a', model: '' }] }), /model/)
  assert.throws(() => normalizeConfig({ providers: [{ name: 'acp-a', model: 'gemini-1' }, { name: 'acp-a', model: 'gemini-2' }] }), /重复/)
})

test('配置：gate / permission / quota / --model 校验', () => {
  assert.throws(() => normalizeConfig({ gate: 'maybe', providers: PROVIDERS }), /gate/)
  assert.throws(() => normalizeConfig({ gateConfidence: 1.5, providers: PROVIDERS }), /gateConfidence/)
  assert.throws(() => normalizeConfig({ gateConfidence: '0.5', providers: PROVIDERS }), /gateConfidence/)
  assert.throws(() => normalizeConfig({ permission: 'maybe', providers: PROVIDERS }), /permission/)
  assert.throws(() => normalizeConfig({ acpArgs: ['--model', 'x'], providers: PROVIDERS }), /--model/)
  assert.throws(() => normalizeConfig({ quota: { ttlSec: 5 }, providers: PROVIDERS }), /ttlSec/)
  assert.throws(() => normalizeConfig({ quota: { workspace: 'relative' }, providers: PROVIDERS }), /workspace/)
  assert.throws(() => normalizeConfig({
    providers: [{ name: 'acp-a', model: 'gemini-a', extraArgs: ['--model', 'x'] }],
  }), /--model/)
})

test('agy 参数：--model 必须在 acp 之前', () => {
  const config = normalizeConfig({ providers: PROVIDERS, acpArgs: ['--sandbox'] })
  assert.deepEqual(buildAcpArgs(config.providers[0], config), ['--model', 'gemini-3.8-flash-medium', 'acp', '--sandbox'])
  const withEffort = normalizeConfig({
    providers: [{ name: 'acp-a', model: 'gemini-a', extraArgs: ['--effort', 'high'] }],
  })
  assert.deepEqual(buildAcpArgs(withEffort.providers[0], withEffort), ['--model', 'gemini-a', '--effort', 'high', 'acp', '--sandbox'])
})

test('模块解析：能从 profile 解析 ACP 插件', { skip: !existsSync('/root/.dsh/profiles/web/package.json') }, async () => {
  const config = normalizeConfig({ providers: PROVIDERS })
  const module = await loadAcpModule(config)
  assert.equal(typeof module.apply, 'function')
  assert.equal(module.name, 'subagent-acp')
})
