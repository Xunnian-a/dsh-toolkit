import assert from 'node:assert/strict'
import test from 'node:test'

import { availabilityFromSummary, gateDecision, pickProvider, preferGroup } from '../lib/select.js'

const PROVIDERS = [
  { name: 'acp-gemini-flash', model: 'gemini-3.8-flash-medium', group: 'gemini' },
  { name: 'acp-claude-sonnet', model: 'claude-sonnet-4-6', group: 'claude' },
]

test('按任务类型选组：短任务 gemini，长文/设计/评审 claude', () => {
  assert.equal(preferGroup({ prompt: '修一下这个 bug' }), 'gemini')
  assert.equal(preferGroup({ prompt: 'x'.repeat(800) }), 'claude')
  assert.equal(preferGroup({ prompt: '写一篇综述' }), 'claude')
  assert.equal(preferGroup({ prompt: 'review 这个设计' }), 'claude')
  assert.equal(preferGroup({ prompt: '短任务', profile: 'strong' }), 'claude')
  assert.equal(preferGroup({ prompt: '写综述', profile: 'fast' }), 'gemini')
})

test('额度可用性映射：两组都可用 / 一组耗尽', () => {
  const full = availabilityFromSummary({
    groups: {
      'Gemini Models': { five_hour_pct: 99, weekly_pct: 80 },
      'Claude and GPT models': { five_hour_pct: 0, weekly_pct: 40 },
    },
  })
  assert.deepEqual(full, { gemini: true, claude: false })
  assert.equal(availabilityFromSummary({}), undefined)
  assert.equal(availabilityFromSummary({ groups: { Other: { five_hour_pct: 1, weekly_pct: 1 } } }), undefined)
})

test('挑 provider：优先组不可用时降级到另一组', () => {
  const gemini = pickProvider({ providers: PROVIDERS, preferred: 'gemini', availability: { gemini: true, claude: true } })
  assert.equal(gemini.provider.name, 'acp-gemini-flash')
  assert.equal(gemini.fallback, false)

  const fallback = pickProvider({ providers: PROVIDERS, preferred: 'gemini', availability: { gemini: false, claude: true } })
  assert.equal(fallback.provider.name, 'acp-claude-sonnet')
  assert.equal(fallback.fallback, true)

  const strong = pickProvider({ providers: PROVIDERS, preferred: 'claude', availability: undefined })
  assert.equal(strong.provider.name, 'acp-claude-sonnet')

  assert.throws(() => pickProvider({
    providers: PROVIDERS,
    preferred: 'gemini',
    availability: { gemini: false, claude: false },
  }), /没有可用的 provider/)
})

test('挑 provider：只读 provider 不参与 auto 选择', () => {
  const withReview = [
    ...PROVIDERS,
    { name: 'acp-gemini-review', model: 'gemini-3.8-flash-medium', group: 'gemini', permission: 'reject' },
  ]
  const picked = pickProvider({ providers: withReview, preferred: 'gemini', availability: { gemini: true, claude: true } })
  assert.equal(picked.provider.name, 'acp-gemini-flash')
  assert.throws(() => pickProvider({
    providers: [{ name: 'acp-only-review', model: 'gemini-3.8-flash-medium', group: 'gemini', permission: 'reject' }],
    preferred: 'gemini',
    availability: { gemini: true, claude: true },
  }), /没有可用的 provider/)
})

test('Jev 门禁：dsh 且置信度达到阈值才给建议', () => {
  assert.equal(gateDecision({ route: 'dsh', confidence: 0.88 }), 'advice')
  assert.equal(gateDecision({ route: 'dsh', confidence: 0.3 }), 'proceed')
  assert.equal(gateDecision({ route: 'dsh' }), 'proceed')
  assert.equal(gateDecision({ route: 'agy', confidence: 0.9 }), 'proceed')
  assert.equal(gateDecision({}), 'proceed')
  assert.equal(gateDecision({ route: 'dsh', confidence: 0.6, threshold: 0.7 }), 'proceed')
  assert.equal(gateDecision({ route: 'dsh', confidence: 0.75, threshold: 0.7 }), 'advice')
})
