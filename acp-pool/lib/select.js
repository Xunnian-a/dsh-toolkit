/** 纯决策函数：任务类型 → 额度组；额度可用性；Jev 门禁。 */

/** 长文/重推理任务的信号词。 */
export const STRONG_HINTS = /综述|论文|研究|长文|报告|架构|设计|重构|分析|评审|调研|review|design|architecture|refactor|analysis|research|summar/i

/** auto 模式下按 prompt 长度 + 信号词选组；fast/strong 直接指定。 */
export function preferGroup({ prompt = '', description = '', profile = 'auto' } = {}) {
  if (profile === 'fast') return 'gemini'
  if (profile === 'strong') return 'claude'
  const text = `${description}\n${prompt}`
  return text.length >= 800 || STRONG_HINTS.test(text) ? 'claude' : 'gemini'
}

/** 把 /usage summary 转成 {gemini: boolean, claude: boolean}；无法判断时返回 undefined。 */
export function availabilityFromSummary(summary) {
  const groups = summary?.groups
  if (groups === null || typeof groups !== 'object' || Array.isArray(groups)) return undefined
  const result = {}
  for (const [name, value] of Object.entries(groups)) {
    const key = /gemini/i.test(name) ? 'gemini' : /(claude|gpt)/i.test(name) ? 'claude' : undefined
    if (key === undefined) continue
    const five = typeof value?.five_hour_pct === 'number' ? value.five_hour_pct : 100
    const week = typeof value?.weekly_pct === 'number' ? value.weekly_pct : 100
    result[key] = five > 0 && week > 0
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * 在可用组里按偏好挑第一个 provider。
 * @returns {{provider: object, group: string, fallback: boolean, reason: string}}
 */
export function pickProvider({ providers, preferred, availability }) {
  const order = preferred === 'claude' ? ['claude', 'gemini'] : ['gemini', 'claude']
  const isAvailable = (group) => availability === undefined || availability[group] !== false
  // 只读 provider 需要显式指定，不参与 auto 选择，避免普通任务被拒写。
  const candidates = providers.filter((item) => item.permission !== 'reject')
  for (const group of order) {
    if (!isAvailable(group)) continue
    const provider = candidates.find((item) => item.group === group)
    if (provider === undefined) continue
    const fallback = group !== preferred
    return {
      provider,
      group,
      fallback,
      reason: fallback
        ? `${preferred} 组额度不可用，切到 ${group} 组（${provider.model}）`
        : `按任务类型选 ${group} 组（${provider.model}）`,
    }
  }
  throw new Error('没有可用的 provider：两组额度都不可用，或只剩只读 provider；等重置，或显式指定 provider')
}

/** Jev 说 dsh 且置信度 ≥ threshold 时只给建议、不启动子 agent。 */
export function gateDecision({ route, confidence, threshold = 0.5 } = {}) {
  return route === 'dsh' && typeof confidence === 'number' && confidence >= threshold ? 'advice' : 'proceed'
}
