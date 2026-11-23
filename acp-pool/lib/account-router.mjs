/**
 * account-router.mjs —— 账号选择（spec 第五节），纯函数
 *
 * 输入：(accounts, quotaSnapshot, lastPickedId, cooldownMap, options)
 * 输出：成功 { account, reason, score, skipped }，失败 { error, details }
 *
 * 优先级规则：
 *   1. 指定账号（options.forced，即 --mux-account，非 'auto'）优先，直接用
 *      - 指定账号不存在 → 报错
 *      - 指定账号在冷却中 → 报错（不能偷偷换成别的账号，否则就违背了"强制指定"；
 *        而且如果硬发过去，会在 故障→冷却→再选中它 之间死循环）
 *   2. 跳过冷却中的账号
 *   3. 跳过额度 <= 阈值（10%）的账号；快照里没有的账号视为无数据，同样跳过
 *   4. 剩下的按额度从高到低排
 *   5. 最高额度有并列时轮换（round-robin）：按账号表顺序，取 lastPickedId 之后的第一个
 *   6. 一个都不剩 → { error }，message 列出每个账号不可用的原因
 *
 * 纯函数约定：不读时钟、不改入参。当前时间通过 options.now 传入
 * （为了方便使用，缺省时取 Date.now()；单测请显式传 now）。
 *
 * 注意：轮换状态 lastPickedId 由调用方保存。这里只负责"决定"，
 * 冷却标记、会话绑定（sessionId → 账号）都由 bin/agy-mux.mjs 维护。
 */

export const DEFAULT_THRESHOLD = 10; // 剩余额度必须 > 10% 才可用
export const DEFAULT_COOLDOWN_MS = 300_000; // 故障转移冷却 300 秒（spec 第六节）

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 从 Map 或普通对象里取值 */
function lookup(container, key) {
  if (!container) return undefined;
  if (container instanceof Map) return container.get(key);
  if (typeof container === 'object' && hasOwn(container, key)) return container[key];
  return undefined;
}

/** 百分比格式化：93 -> "93%"，93.25 -> "93.3%" */
function fmtPct(n) {
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * 查询某账号是否在冷却中。
 * cooldownMap 支持 Map 或普通对象，值支持两种形式：
 *   - number：冷却截止时间戳（ms）
 *   - { until: number, reason?: string }
 *
 * @returns {{until: number, remainingMs: number, reason: string} | null} 没在冷却返回 null
 */
export function getCooldown(cooldownMap, accountId, now) {
  const v = lookup(cooldownMap, accountId);
  if (v == null) return null;
  const until = typeof v === 'number' ? v : Number(v?.until);
  if (!Number.isFinite(until) || until <= now) return null; // 已过期 = 不在冷却
  const reason = typeof v === 'object' && v.reason ? String(v.reason) : 'cooldown';
  return { until, remainingMs: until - now, reason };
}

/**
 * 返回一个新的冷却表（不修改原表），给 accountId 加上冷却。
 * 供 mux 在识别到 RESOURCE_EXHAUSTED / quota / 429 / Authentication required 时调用。
 *
 * @returns {Map<string, {until: number, reason: string}>}
 */
export function withCooldown(cooldownMap, accountId, reason, now, ms = DEFAULT_COOLDOWN_MS) {
  const next = new Map(cooldownMap instanceof Map ? cooldownMap : Object.entries(cooldownMap ?? {}));
  next.set(accountId, { until: now + ms, reason: String(reason ?? 'cooldown') });
  return next;
}

/** 从快照取额度分；缺失或非数字返回 null */
function scoreOf(quotaSnapshot, accountId, group = null) {
  const v = lookup(quotaSnapshot, accountId);
  if (v == null) return null;
  // 支持两种快照：数字（旧）与 {gemini, claude, score}（新，按组）
  if (typeof v === 'object') {
    const pick = group && Number.isFinite(Number(v[group])) ? Number(v[group]) : Number(v.score);
    return Number.isFinite(pick) ? pick : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 选账号。
 *
 * @param {Array<{id: string, home?: string, label?: string}>} accounts  账号表（顺序即轮换顺序）
 * @param {Record<string, number> | Map<string, number>} quotaSnapshot  {accountId: 0..100}
 * @param {string|null|undefined} lastPickedId   上一次选中的账号 id（轮换状态）
 * @param {Map|object|null|undefined} cooldownMap  冷却表，见 getCooldown
 * @param {{forced?: string|null, threshold?: number, now?: number}} [options]
 * @returns {{account: object, reason: string, score: number, skipped: Array<{id: string, reason: string}>}
 *          | {error: string, details: Array<{id: string, reason: string}>}}
 */
export function pickAccount(accounts, quotaSnapshot, lastPickedId, cooldownMap, options = {}) {
  const { forced = null, threshold = DEFAULT_THRESHOLD, now = Date.now(), group = null } = options;

  const list = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a.id === 'string' && a.id) : [];
  if (list.length === 0) {
    return { error: 'agy-mux: no accounts configured', details: [] };
  }

  // ---------- 1. 指定账号优先 ----------
  if (forced && forced !== 'auto') {
    const acc = list.find((a) => a.id === forced);
    if (!acc) {
      return {
        error: `agy-mux: forced account "${forced}" not found (known: ${list.map((a) => a.id).join(', ')})`,
        details: [{ id: String(forced), reason: 'not-found' }],
      };
    }
    const cd = getCooldown(cooldownMap, acc.id, now);
    if (cd) {
      const reason = `cooldown(${cd.reason}, ${Math.ceil(cd.remainingMs / 1000)}s left)`;
      return {
        error: `agy-mux: forced account ${acc.id} unavailable: ${reason}`,
        details: [{ id: acc.id, reason }],
      };
    }
    // 指定账号不看额度阈值：用户明确要求，就照办；额度只写进 reason 方便排查
    const s = scoreOf(quotaSnapshot, acc.id, group);
    return {
      account: acc,
      reason: `forced(quota=${s == null ? '?' : fmtPct(s)})`,
      score: s ?? 0,
      skipped: [],
    };
  }

  // ---------- 2/3. 逐个评估：冷却 → 无数据 → 低于阈值 ----------
  const skipped = []; // 不可用账号及原因（全不可用时用来拼错误信息）
  const candidates = []; // { acc, index, score }
  list.forEach((acc, index) => {
    const cd = getCooldown(cooldownMap, acc.id, now);
    if (cd) {
      skipped.push({ id: acc.id, reason: `cooldown(${cd.reason}, ${Math.ceil(cd.remainingMs / 1000)}s left)` });
      return;
    }
    const s = scoreOf(quotaSnapshot, acc.id, group);
    if (s == null) {
      skipped.push({ id: acc.id, reason: 'no-quota-data' });
      return;
    }
    if (!(s > threshold)) {
      skipped.push({ id: acc.id, reason: `quota(${fmtPct(s)}<=${threshold}%)` });
      return;
    }
    candidates.push({ acc, index, score: s });
  });

  // ---------- 6. 全不可用 ----------
  if (candidates.length === 0) {
    return {
      error: `agy-mux: no available account: ${skipped.map((d) => `${d.id}=${d.reason}`).join('; ')}`,
      details: skipped,
    };
  }

  // ---------- 4. 额度降序；同分按账号表顺序（保证结果确定） ----------
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = candidates[0].score;
  const ties = candidates.filter((c) => c.score === top); // 已按 index 升序

  // ---------- 5. 并列时轮换 ----------
  let chosen = ties[0];
  let reason;
  if (ties.length > 1) {
    // 按账号表顺序找 lastPickedId 之后的第一个并列账号，到底就回到开头。
    // 用"表中位置"而不是"在 ties 里的位置"：即使上一个账号现在冷却/掉出并列，
    // 也会继续往后轮，而不是回到第一个账号上反复压。
    const lastIndex = list.findIndex((a) => a.id === lastPickedId);
    chosen = ties.find((c) => c.index > lastIndex) ?? ties[0];
    reason = `quota(${fmtPct(top)} tie x${ties.length}, rr after ${lastPickedId ?? 'none'})`;
  } else if (candidates.length > 1) {
    // spec 第八节样例格式：quota(93%>88%)，与第二名比较
    reason = `quota(${fmtPct(top)}>${fmtPct(candidates[1].score)})`;
  } else {
    reason = `quota(${fmtPct(top)}, only)`;
  }

  return { account: chosen.acc, reason, score: chosen.score, skipped };
}
