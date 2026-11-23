#!/usr/bin/env node
// agy-mux：ACP stdio 透明代理，对上游伪装成 agy，下游按账号池多路复用 agy 子进程。
// 用法：agy-mux --model <M> acp [--sandbox] [--mux-account id] [--mux-trace id] [--mux-log path] [--mux-accounts path]

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import process from 'node:process';
import { createQuotaCache } from '../lib/quota-cache.mjs';
import { pickAccount, withCooldown, getCooldown } from '../lib/account-router.mjs';

// ───────────────────────── 常量 ─────────────────────────
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const AGY_BIN = process.env.AGY_MUX_AGY_BIN || join(homedir(), '.local/bin/agy');
let MODEL_GROUP = null; // 由 argv 的 --model 决定，见下方 parseArgs 之后
const COOLDOWN_MS = 300_000;
const QUOTA_TTL_MS = 60_000;
const RETRYABLE_RE = /RESOURCE_EXHAUSTED|quota|429|Authentication required/i;
const TOKEN_REL = join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const FAILOVER_METHODS = new Set(['initialize', 'session/new']);
const USAGE =
  'usage: agy-mux --model <M> acp [--sandbox] [--mux-account id] [--mux-trace id] [--mux-log path] [--mux-accounts path]';

function fatal(msg, code = 2) {
  process.stderr.write(`[agy-mux] fatal: ${msg}\n`);
  process.exit(code);
}

function trunc(s, n = 300) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ───────────────────────── 参数解析 ─────────────────────────
// --model 原样保留；acp 为子命令；--sandbox 原样保留；--mux-* 仅 mux 自用，不透传给 agy。
function parseArgs(argv) {
  const opts = { model: null, sandbox: false, sub: null, account: null, trace: null, log: null, accounts: null, ignored: [] };
  const valued = {
    '--model': 'model',
    '--mux-account': 'account',
    '--mux-trace': 'trace',
    '--mux-log': 'log',
    '--mux-accounts': 'accounts',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (Object.hasOwn(valued, flag)) {
      let v;
      if (eq > 0) v = a.slice(eq + 1);
      else {
        v = argv[++i];
        if (v === undefined) fatal(`${flag} 缺少参数值\n${USAGE}`);
      }
      opts[valued[flag]] = v;
    } else if (a === '--sandbox') {
      opts.sandbox = true;
    } else if (a.startsWith('--mux-')) {
      fatal(`未知的 mux 参数: ${a}\n${USAGE}`);
    } else if (a === 'acp' && !opts.sub) {
      opts.sub = 'acp';
    } else {
      opts.ignored.push(a);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
// 选账号时看哪一组额度：按模型名前缀判断（gemini-* 看 gemini 组，claude-*/gpt-* 看 claude 组）
MODEL_GROUP = /^gemini/i.test(opts.model || '') ? 'gemini'
  : /^(claude|gpt)/i.test(opts.model || '') ? 'claude'
  : null;
if (opts.sub !== 'acp') fatal(`缺少 acp 子命令\n${USAGE}`);
if (!opts.model) fatal(`缺少 --model\n${USAGE}`);

const MODEL = opts.model;
const SANDBOX = opts.sandbox;
const TRACE = opts.trace || `${process.pid}-${Date.now().toString(36)}`;
const LOG_PATH = opts.log ? resolve(opts.log) : null;
const ACCOUNTS_PATH = resolve(opts.accounts || join(BIN_DIR, 'mux.accounts.json'));

// ───────────────────────── 日志 ─────────────────────────
let logFileWarned = false;
function log(event, { account = null, sessionId = null, detail = null } = {}) {
  const parts = [`[agy-mux] ${event}`];
  if (account) parts.push(`account=${account}`);
  if (sessionId) parts.push(`session=${sessionId}`);
  if (detail !== null && detail !== undefined && detail !== '') {
    parts.push(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  process.stderr.write(`${parts.join(' ')}\n`);
  if (LOG_PATH) {
    try {
      appendFileSync(
        LOG_PATH,
        `${JSON.stringify({ ts: new Date().toISOString(), trace: TRACE, event, account, sessionId, detail })}\n`,
      );
    } catch (e) {
      if (!logFileWarned) {
        logFileWarned = true;
        process.stderr.write(`[agy-mux] 无法写入 --mux-log ${LOG_PATH}: ${e.message}\n`);
      }
    }
  }
}

// ───────────────────────── 账号表加载与校验 ─────────────────────────
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

const invalidReasons = new Map(); // accountId -> 校验失败原因

function loadAccounts(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { fatal(`无法读取账号表 ${path}: ${e.message}`, 1); }
  let list;
  try { list = JSON.parse(raw); } catch (e) { fatal(`账号表不是合法 JSON ${path}: ${e.message}`, 1); }
  if (!Array.isArray(list) || list.length === 0) fatal(`账号表必须是非空数组: ${path}`, 1);

  const seen = new Set();
  return list.map((a, i) => {
    if (!a || typeof a !== 'object') fatal(`账号表第 ${i} 项不是对象`, 1);
    if (typeof a.id !== 'string' || !a.id) fatal(`账号表第 ${i} 项缺少 id`, 1);
    if (seen.has(a.id)) fatal(`账号 id 重复: ${a.id}`, 1);
    seen.add(a.id);
    if (typeof a.home !== 'string' || !a.home) fatal(`账号 ${a.id} 缺少 home`, 1);

    // home 允许相对路径，相对账号表所在目录解析
    const home = resolve(dirname(path), a.home);
    const tokenPath = join(home, TOKEN_REL);
    if (!isDir(home)) invalidReasons.set(a.id, `home not found: ${home}`);
    else if (!isFile(tokenPath)) invalidReasons.set(a.id, `oauth token missing: ${tokenPath}`);

    return { id: a.id, home, label: typeof a.label === 'string' && a.label ? a.label : a.id };
  });
}

const ACCOUNTS = loadAccounts(ACCOUNTS_PATH);
const accountById = new Map(ACCOUNTS.map((a) => [a.id, a]));
const VALID = ACCOUNTS.filter((a) => !invalidReasons.has(a.id));

for (const [id, why] of invalidReasons) log('account-invalid', { account: id, detail: why });
if (opts.account && !accountById.has(opts.account)) fatal(`--mux-account 指定的账号不存在: ${opts.account}`, 1);
if (opts.account && invalidReasons.has(opts.account)) {
  log('pin-invalid', { account: opts.account, detail: `--mux-account 未通过校验，将忽略固定: ${invalidReasons.get(opts.account)}` });
}
if (!VALID.length) log('no-valid-account', { detail: '所有账号均未通过校验，请求将返回 -32000' });
if (opts.ignored.length) log('args-ignored', { detail: opts.ignored.join(' ') });

const quota = VALID.length ? createQuotaCache({ accounts: VALID, agyBin: AGY_BIN, ttlMs: QUOTA_TTL_MS }) : null;

// ───────────────────────── 运行时状态 ─────────────────────────
let cooldownMap = {};
let lastPickedId = null;
let currentAccountId = null; // 新会话 / 无会话消息默认发往的账号
let initParams; // 上游 initialize 的 params，用于向新子进程补发
let hasInitParams = false;
const children = new Map(); // accountId -> 最新子进程记录
const liveChildren = new Set(); // 所有尚未退出的子进程
const sessions = new Map(); // sessionId -> { accountId, child }
const pending = new Map(); // 发往子进程的内部 id -> { child, resolve? | upstreamId, method, sessionId }
const reverse = new Map(); // 'mux:n' -> { child, origId }（子进程 → 上游请求的 id 改写）
let nextId = 1;
let nextRevId = 1;
let shuttingDown = false;

// ───────────────────────── I/O 辅助 ─────────────────────────
let stdoutBroken = false;
function sendUp(msg) {
  if (stdoutBroken) return;
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function writeChild(c, msg) {
  if (!c || c.dead || !c.proc.stdin || !c.proc.stdin.writable) return false;
  c.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  return true;
}

function toUpstream(resp, id) {
  const out = { jsonrpc: '2.0', id };
  if (resp.error !== undefined) out.error = resp.error;
  else out.result = resp.result === undefined ? null : resp.result;
  return out;
}

function isCooling(id) {
  return !!getCooldown(cooldownMap, id, Date.now());
}

function coolText(id) {
  const now = Date.now();
  const cd = getCooldown(cooldownMap, id, now);
  if (!cd) return null;
  if (typeof cd !== 'object') return `cooldown: ${String(cd)}`;
  const until = cd.until ?? cd.expiresAt ?? cd.untilMs;
  const remain = typeof until === 'number' ? Math.max(0, Math.ceil((until - now) / 1000)) : null;
  return `cooldown${remain !== null ? ` ${remain}s` : ''}: ${cd.reason ?? 'unknown'}`;
}

// ───────────────────────── 子进程管理 ─────────────────────────
function ensureChild(acc) {
  const existing = children.get(acc.id);
  if (existing && !existing.dead) return existing;

  // 注意：--model M 必须在 acp 之前
  const args = ['--model', MODEL, ...(SANDBOX ? ['--sandbox'] : []), 'acp'];
  const proc = spawn(AGY_BIN, args, {
    env: { ...process.env, HOME: acc.home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const c = { id: acc.id, proc, dead: false, initialized: false, killedByMux: false, stderrTail: [], stdinWarned: false };
  children.set(acc.id, c);
  liveChildren.add(c);
  log('spawn', { account: acc.id, detail: `pid=${proc.pid ?? '?'} ${AGY_BIN} ${args.join(' ')}` });

  proc.stdin.on('error', (e) => {
    if (!c.stdinWarned) {
      c.stdinWarned = true;
      log('child-stdin-error', { account: c.id, detail: e.message });
    }
  });

  // 子进程 stdout：逐行 JSON-RPC
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => onChildLine(c, line));

  // 子进程 stderr：加前缀转发到 mux 的 stderr，并保留尾部用于故障诊断
  createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (line) => {
    process.stderr.write(`[${c.id}] ${line}\n`);
    c.stderrTail.push(line);
    if (c.stderrTail.length > 20) c.stderrTail.shift();
  });

  proc.on('error', (err) => onChildGone(c, `spawn error: ${err.message}`));
  proc.on('close', (code, signal) => onChildGone(c, `exited code=${code} signal=${signal}`));
  return c;
}

function killChild(c, signal = 'SIGTERM') {
  if (children.get(c.id) === c) children.delete(c.id);
  if (c.dead) return;
  c.killedByMux = true;
  try { c.proc.kill(signal); } catch { /* ignore */ }
}

// 子进程退出：所有挂起请求以错误结束（等待中的标记 __exited 以便故障转移）
function onChildGone(c, why) {
  if (c.dead) return;
  c.dead = true;
  liveChildren.delete(c);
  if (children.get(c.id) === c) children.delete(c.id);

  const tail = c.stderrTail.slice(-5).join(' | ');
  const reason = trunc(
    `agy child (${c.id}) ${c.killedByMux ? `terminated by mux (${why})` : why}${tail ? `; stderr: ${tail}` : ''}`,
    500,
  );
  log('child-exit', { account: c.id, detail: reason });

  for (const [id, p] of pending) {
    if (p.child !== c) continue;
    pending.delete(id);
    const error = { code: -32000, message: reason };
    if (p.resolve) p.resolve({ jsonrpc: '2.0', id, error, __exited: true });
    else if (!shuttingDown) sendUp({ jsonrpc: '2.0', id: p.upstreamId, error });
  }
  for (const [rid, r] of reverse) if (r.child === c) reverse.delete(rid);
}

// 向子进程发请求并等待其响应（用于 initialize / session/new 及 initialize 补发）
function childCall(c, method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, { child: c, resolve: res, method });
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    if (!writeChild(c, msg)) {
      pending.delete(id);
      res({ jsonrpc: '2.0', id, error: { code: -32000, message: `agy child (${c.id}) stdin not writable` }, __exited: true });
    }
  });
}

function bindSession(sessionId, c, via) {
  sessions.set(sessionId, { accountId: c.id, child: c });
  log('session-bound', { account: c.id, sessionId, detail: `via ${via}` });
}

// ───────────────────────── 子进程 → 上游 ─────────────────────────
function onChildLine(c, line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`[${c.id}] (stdout non-json) ${line}\n`);
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    log('child-bad-message', { account: c.id, detail: trunc(line) });
    return;
  }

  const hasMethod = typeof msg.method === 'string';
  const hasId = msg.id !== undefined && msg.id !== null;

  if (hasMethod && hasId) {
    // 子进程发给客户端的请求（如 session/request_permission、fs/*）：改写 id 防止多子进程间冲突
    const muxId = `mux:${nextRevId++}`;
    reverse.set(muxId, { child: c, origId: msg.id });
    sendUp({ ...msg, id: muxId });
  } else if (hasMethod) {
    // 通知（如 session/update）原样透传
    sendUp(msg);
  } else if (hasId) {
    handleChildResponse(c, msg);
  } else {
    log('child-unrouted', { account: c.id, detail: trunc(line) });
  }
}

function handleChildResponse(c, msg) {
  const p = pending.get(msg.id);
  if (!p || p.child !== c) {
    log('orphan-response', { account: c.id, detail: `id=${JSON.stringify(msg.id)}` });
    return;
  }
  pending.delete(msg.id);
  if (p.resolve) {
    p.resolve(msg);
    return;
  }

  if (msg.error) {
    // 已建立会话阶段：命中配额/鉴权错误只记冷却，原样返回，不重放
    const m = String(msg.error.message ?? '');
    if (RETRYABLE_RE.test(m)) {
      cooldownMap = withCooldown(cooldownMap, c.id, trunc(m, 200), Date.now(), COOLDOWN_MS);
      log('cooldown', { account: c.id, sessionId: p.sessionId, detail: `${p.method}: ${trunc(m)} (no replay)` });
    }
  } else if (p.sessionId && !sessions.has(p.sessionId)) {
    // session/load 等成功后，把该会话绑定到实际承载的账号
    bindSession(p.sessionId, c, p.method);
  } else if (p.method === 'session/new' && typeof msg.result?.sessionId === 'string') {
    bindSession(msg.result.sessionId, c, p.method);
  }
  sendUp(toUpstream(msg, p.upstreamId));
}

// ───────────────────────── 选账号 ─────────────────────────
async function selectAccount(tried) {
  const candidates = VALID.filter((a) => !tried.has(a.id));
  if (!candidates.length) return { error: 'no candidate accounts left', details: [] };

  // --mux-account：首选该账号（未冷却且本轮未尝试过），失败后仍可转移到其他账号
  if (opts.account) {
    const pinned = candidates.find((a) => a.id === opts.account);
    if (pinned && !isCooling(pinned.id)) {
      lastPickedId = pinned.id;
      log('pick', { account: pinned.id, detail: 'reason=pinned(--mux-account)' });
      return { account: pinned, reason: 'pinned', score: null, skipped: [] };
    }
  }

  let snap = {};
  if (quota) {
    try {
      snap = (await (quota.snapshotByGroup?.() ?? quota.snapshot())) || {};
    } catch (e) {
      log('quota-error', { detail: trunc(e?.message || e) });
    }
  }

  const r = pickAccount(candidates, snap, lastPickedId, cooldownMap, { group: MODEL_GROUP });
  if (!r || r.error || !r.account) {
    log('pick-failed', { detail: trunc(r?.error ?? 'pickAccount returned nothing') });
    return { error: r?.error ?? 'pickAccount returned nothing', details: r?.details ?? [] };
  }
  const acc = accountById.get(r.account.id) ?? r.account;
  lastPickedId = acc.id;
  log('pick', {
    account: acc.id,
    detail: `reason=${r.reason} score=${r.score} skipped=${trunc(JSON.stringify(r.skipped ?? []), 200)}`,
  });
  return { ...r, account: acc };
}

// 记录一次账号失败：命中配额/鉴权模式则冷却 300s；无会话的子进程直接回收
function failAccount(acc, c, reason, failures) {
  failures.push({ id: acc.id, reason });
  if (RETRYABLE_RE.test(reason)) {
    cooldownMap = withCooldown(cooldownMap, acc.id, trunc(reason, 200), Date.now(), COOLDOWN_MS);
  }
  const hasSessions = [...sessions.values()].some((s) => s.child === c);
  if (!hasSessions) killChild(c);
  log('failover', { account: acc.id, detail: `reason=${trunc(reason)} cooldown=${RETRYABLE_RE.test(reason) ? COOLDOWN_MS / 1000 + 's' : 'no'}` });
}

function retryable(resp) {
  return !!resp.__exited || RETRYABLE_RE.test(String(resp.error?.message ?? ''));
}

function reasonOf(resp) {
  return trunc(resp.error?.message ?? JSON.stringify(resp.error ?? {}), 400);
}

// 取得一个可用子进程（懒启动的核心）：优先当前账号，否则选新账号；必要时补发 initialize
async function acquireChild({ tried, failures, needInit }) {
  for (;;) {
    let acc = null;
    const cur = currentAccountId ? accountById.get(currentAccountId) : null;
    if (cur && !tried.has(cur.id) && !isCooling(cur.id)) {
      acc = cur;
    } else {
      const sel = await selectAccount(tried);
      if (sel.error) return { unavailable: sel };
      acc = sel.account;
    }
    tried.add(acc.id);

    if (currentAccountId !== acc.id) {
      if (currentAccountId) log('switch', { account: acc.id, detail: `from=${currentAccountId}` });
      currentAccountId = acc.id;
    }

    const c = ensureChild(acc);

    // 新子进程尚未握手：先用上游记录的 initialize 参数补发
    if (needInit && !c.initialized && hasInitParams) {
      const r = await childCall(c, 'initialize', initParams);
      if (r.error) {
        if (retryable(r)) {
          failAccount(acc, c, reasonOf(r), failures);
          continue;
        }
        return { error: r.error };
      }
      c.initialized = true;
    }
    return { child: c, account: acc };
  }
}

// ───────────────────────── 所有账号不可用 ─────────────────────────
function normalizeDetails(details) {
  const map = new Map();
  for (const d of Array.isArray(details) ? details : []) {
    if (typeof d === 'string') {
      const m = d.match(/^([^:\s：]+)\s*[:：]\s*(.*)$/);
      if (m) map.set(m[1], m[2]);
    } else if (d && typeof d === 'object') {
      const id = d.id ?? d.accountId ?? d.account?.id;
      if (id) map.set(id, d.reason ?? d.error ?? d.message ?? JSON.stringify(d));
    }
  }
  return map;
}

function replyUnavailable(id, failures, sel) {
  const failMap = new Map(failures.map((f) => [f.id, f.reason]));
  const detailMap = normalizeDetails(sel?.details);
  const rows = ACCOUNTS.map((a) => ({
    id: a.id,
    reason:
      failMap.get(a.id) ??
      invalidReasons.get(a.id) ??
      coolText(a.id) ??
      detailMap.get(a.id) ??
      'unavailable',
  }));
  const message = `agy-mux: no account available${sel?.error ? ` (${sel.error})` : ''} — ${rows
    .map((r) => `${r.id}: ${r.reason}`)
    .join('; ')}`;
  log('unavailable', { detail: trunc(message, 800) });
  sendUp({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { trace: TRACE, accounts: rows } } });
}

// ───────────────────────── 上游 → 子进程 ─────────────────────────
// initialize / session/new：等待子进程响应，命中可转移错误时换账号重建子进程并重放
async function forwardWithFailover(msg) {
  if (msg.method === 'initialize') {
    initParams = msg.params;
    hasInitParams = true;
  }
  const tried = new Set();
  const failures = [];

  for (;;) {
    const got = await acquireChild({ tried, failures, needInit: msg.method !== 'initialize' });
    if (got.unavailable) return replyUnavailable(msg.id, failures, got.unavailable);
    if (got.error) return sendUp({ jsonrpc: '2.0', id: msg.id, error: got.error });

    const { child: c, account: acc } = got;
    log('forward', { account: acc.id, detail: `${msg.method} id=${JSON.stringify(msg.id)}` });
    const resp = await childCall(c, msg.method, msg.params);

    if (resp.error && retryable(resp)) {
      // 握手/建会话阶段失败：冷却并转移到下一个账号，重放当前请求
      failAccount(acc, c, reasonOf(resp), failures);
      continue;
    }

    if (!resp.error) {
      if (msg.method === 'initialize') c.initialized = true;
      // session/new 成功：记录 sessionId -> 账号，此后该会话只发往此账号
      if (msg.method === 'session/new' && typeof resp.result?.sessionId === 'string') {
        bindSession(resp.result.sessionId, c, 'session/new');
      }
    }
    sendUp(toUpstream(resp, msg.id));
    return;
  }
}

// 其余请求/通知：按 sessionId 路由，不重放
async function forwardDirect(msg, isRequest) {
  const sid = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : null;
  const bound = sid ? sessions.get(sid) : null;
  let c;

  if (bound) {
    c = bound.child;
    if (c.dead) {
      const message = `agy-mux: session ${sid} is bound to account ${bound.accountId}, whose agy child has exited; session cannot be recovered`;
      log('session-dead', { account: bound.accountId, sessionId: sid, detail: msg.method });
      if (isRequest) sendUp({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
      return;
    }
  } else if (!isRequest) {
    // 通知不触发懒启动，只发往当前子进程
    const cur = currentAccountId ? children.get(currentAccountId) : null;
    if (!cur || cur.dead) {
      log('drop-notification', { sessionId: sid, detail: msg.method });
      return;
    }
    c = cur;
  } else {
    const failures = [];
    const got = await acquireChild({ tried: new Set(), failures, needInit: true });
    if (got.unavailable) return replyUnavailable(msg.id, failures, got.unavailable);
    if (got.error) return sendUp({ jsonrpc: '2.0', id: msg.id, error: got.error });
    c = got.child;
  }

  if (!isRequest) {
    writeChild(c, msg);
    return;
  }

  const id = nextId++;
  pending.set(id, { child: c, upstreamId: msg.id, method: msg.method, sessionId: sid });
  log('forward', { account: c.id, sessionId: sid, detail: `${msg.method} id=${JSON.stringify(msg.id)}` });
  if (!writeChild(c, { ...msg, id })) {
    pending.delete(id);
    sendUp({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: `agy-mux: agy child (${c.id}) is not writable` },
    });
  }
}

async function handleUpstreamRequest(msg) {
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (isRequest && FAILOVER_METHODS.has(msg.method)) return forwardWithFailover(msg);
  return forwardDirect(msg, isRequest);
}

// 上游对子进程请求的响应：还原原始 id 后发回对应子进程（不排队，避免与阻塞中的请求死锁）
function handleUpstreamResponse(msg) {
  const r = reverse.get(msg.id);
  if (!r) {
    log('orphan-upstream-response', { detail: `id=${JSON.stringify(msg.id)}` });
    return;
  }
  reverse.delete(msg.id);
  if (!writeChild(r.child, { ...msg, id: r.origId })) {
    log('drop-upstream-response', { account: r.child.id, detail: `child gone, id=${JSON.stringify(msg.id)}` });
  }
}

// 请求/通知串行派发，保证顺序（initialize / session/new 会阻塞到拿到结果为止）
let queue = Promise.resolve();
function enqueue(msg) {
  queue = queue
    .then(() => (shuttingDown ? undefined : handleUpstreamRequest(msg)))
    .catch((err) => {
      log('internal-error', { detail: trunc(err?.stack || String(err), 800) });
      if (msg.id !== undefined && msg.id !== null) {
        sendUp({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: `agy-mux internal error: ${err?.message || err}` },
        });
      }
    });
}

// ───────────────────────── 退出处理 ─────────────────────────
async function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown', { detail: `${reason} children=${liveChildren.size}` });

  // 杀掉所有子进程：先 SIGTERM，2s 未退出则 SIGKILL
  const waits = [...liveChildren].map(
    (c) =>
      new Promise((res) => {
        if (c.dead) return res();
        const t = setTimeout(() => {
          try { c.proc.kill('SIGKILL'); } catch { /* ignore */ }
          res();
        }, 2000);
        c.proc.once('close', () => {
          clearTimeout(t);
          res();
        });
        killChild(c);
      }),
  );
  await Promise.all(waits);
  process.exit(code);
}

process.on('SIGINT', () => shutdown('SIGINT', 130));
process.on('SIGTERM', () => shutdown('SIGTERM', 143));
process.on('uncaughtException', (err) => {
  log('uncaught-exception', { detail: trunc(err?.stack || String(err), 800) });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  log('unhandled-rejection', { detail: trunc(err?.stack || String(err), 800) });
});
process.stdout.on('error', (e) => {
  stdoutBroken = true;
  shutdown(`stdout error: ${e.code || e.message}`, 0);
});

// ───────────────────────── 主循环：逐行读取上游 stdin ─────────────────────────
log('start', {
  detail: `model=${MODEL} sandbox=${SANDBOX} accounts=${VALID.map((a) => a.id).join(',') || '(none)'} file=${ACCOUNTS_PATH} trace=${TRACE}`,
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (shuttingDown || !line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    sendUp({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    sendUp({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if (typeof msg.method !== 'string') {
    // 无 method：是上游对子进程请求的响应
    handleUpstreamResponse(msg);
    return;
  }
  enqueue(msg);
});

rl.on('close', () => shutdown('stdin closed', 0));
