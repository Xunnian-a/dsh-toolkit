import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUsage } from '../lib/quota-cache.mjs';
import { pickAccount, withCooldown, getCooldown, DEFAULT_THRESHOLD } from '../lib/account-router.mjs';

const ACCOUNTS = [
  { id: 'main', home: '/root', label: 'account-a' },
  { id: 'acc3', home: '/home/account-b', label: 'account-b' },
];

// 真实 `agy -p "/usage"` 的输出（制表符分隔）
const REAL_USAGE = [
  'Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-29T13:05:33Z',
  'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-22T18:05:33Z',
  'Claude and GPT models\tWeekly Limit Remaining\t94%\t2026-11-25T13:28:08Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-22T18:05:33Z',
  'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-29T13:05:33Z',
].join('\n');

test('parseUsage：解析真实输出，分组正确', () => {
  const p = parseUsage(REAL_USAGE);
  assert.equal(p.gemini, 100);
  assert.equal(p.claude, 94);
  assert.equal(p.score, 94); // 取两组较小值
  assert.equal(p.limits.length, 5);
});

test('parseUsage：某组为 0 时 score 归零', () => {
  const text = [
    'Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-29T13:05:33Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-22T18:05:46Z',
  ].join('\n');
  const p = parseUsage(text);
  assert.equal(p.gemini, 100);
  assert.equal(p.claude, 0);
  assert.equal(p.score, 0);
});

test('pickAccount：按组评分——claude 组耗尽时 Claude 任务跳过该账号', () => {
  const snapshot = {
    main: { gemini: 100, claude: 0, score: 0 },
    acc3: { gemini: 100, claude: 93, score: 93 },
  };
  const r = pickAccount(ACCOUNTS, snapshot, null, {}, { group: 'claude' });
  assert.equal(r.account.id, 'acc3');

  // 同一份快照，Gemini 任务仍可用主脑1（不该被 claude=0 拖累）
  const g = pickAccount(ACCOUNTS, snapshot, null, {}, { group: 'gemini' });
  assert.equal(g.account.id, 'main');
});

test('pickAccount：额度低于阈值被跳过', () => {
  const r = pickAccount(ACCOUNTS, { main: 5, acc3: 80 }, null, {});
  assert.equal(r.account.id, 'acc3');
  assert.equal(r.skipped[0].id, 'main');
  assert.ok(r.skipped[0].reason.includes(String(DEFAULT_THRESHOLD)));
});

test('pickAccount：同额度时轮换，避免总压一个账号', () => {
  const r1 = pickAccount(ACCOUNTS, { main: 90, acc3: 90 }, null, {});
  assert.equal(r1.account.id, 'main');
  const r2 = pickAccount(ACCOUNTS, { main: 90, acc3: 90 }, 'main', {});
  assert.equal(r2.account.id, 'acc3');
});

test('pickAccount：强制指定账号优先于额度', () => {
  const r = pickAccount(ACCOUNTS, { main: 0, acc3: 90 }, null, {}, { forced: 'main' });
  assert.equal(r.account.id, 'main');
});

test('pickAccount：冷却中的账号被跳过', () => {
  const cd = withCooldown({}, 'main', 'RESOURCE_EXHAUSTED', Date.now());
  const r = pickAccount(ACCOUNTS, { main: 95, acc3: 20 }, null, cd);
  assert.equal(r.account.id, 'acc3');
  assert.ok(r.skipped.some((s) => s.id === 'main' && s.reason.includes('cooldown')));
});

test('pickAccount：全部不可用时返回 error 并列出原因', () => {
  const r = pickAccount(ACCOUNTS, { main: 0, acc3: 0 }, null, {});
  assert.ok(r.error);
  assert.equal(r.details.length, 2);
});

test('withCooldown / getCooldown：冷却到期后自动失效', () => {
  const now = 1_000_000;
  const cd = withCooldown({}, 'main', 'quota', now, 1000);
  assert.ok(getCooldown(cd, 'main', now + 500));
  assert.equal(getCooldown(cd, 'main', now + 1500), null);
});

test('pickAccount：旧格式（纯数字）快照仍然兼容', () => {
  const r = pickAccount(ACCOUNTS, { main: 10, acc3: 70 }, null, {});
  assert.equal(r.account.id, 'acc3');
});
