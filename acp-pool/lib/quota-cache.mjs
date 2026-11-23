/**
 * quota-cache.mjs —— 账号额度查询、解析与缓存（spec 第五节）
 *
 * 职责：
 *   1. 对每个账号执行 `HOME=<home> agy -p "/usage"`（子进程超时 15s）
 *   2. 解析输出，按「组」取剩余百分比：
 *        "Gemini Models"          -> gemini
 *        "Claude and GPT models"  -> claude
 *      同一组有多行（Weekly / Five Hour）时取较小值：任何一个窗口耗尽都会让请求失败
 *   3. 账号得分 = min(gemini, claude)
 *   4. 缓存（TTL 默认 300 秒），对外提供 snapshot() -> Promise<{[accountId]: number}>
 *
 * 约束：
 *   - 单账号查询失败（超时、退出码非 0、输出解析不出来）记 0 分，不影响其他账号
 *   - 每个账号同一时刻最多只有一个在跑的 /usage 子进程（in-flight 去重）
 *   - 只用 Node 内置模块
 *
 * 为什么提供可选的磁盘缓存（cacheFile）：
 *   DSH 会给每个 provider 单独拉起一个 agy-mux 进程，只靠进程内的内存缓存，
 *   每次启动都要重新跑 N 次 /usage（每次可能要几秒）。传入 cacheFile 后多个 mux
 *   进程共用一份结果，"启动时读额度缓存" 才真正有用。默认关闭，方便单测。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const DEFAULT_TTL_MS = 300_000; // 成功结果缓存 300 秒（spec 第五节）
export const DEFAULT_FAIL_TTL_MS = 60_000; // 失败结果只缓存 60 秒，让账号能尽快恢复
export const DEFAULT_TIMEOUT_MS = 15_000; // /usage 子进程超时 15 秒
const MAX_OUTPUT_CHARS = 1 << 20; // 输出最多收 1MB，防止异常输出撑爆内存
const CACHE_FILE_VERSION = 1;

// 去掉 ANSI 颜色/控制序列：agy 可能会给输出上色
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// 组名识别：按行首前缀匹配，不区分大小写
// （表头这类不以组名开头的行会自然跳过）
const GROUP_PATTERNS = [
  { key: 'gemini', re: /^gemini\b/i }, // "Gemini Models"
  { key: 'claude', re: /^claude\b/i }, // "Claude and GPT models"
];

/** 把数值限制在 [0, 100] */
function clampPct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * 解析 `agy -p /usage` 的输出。
 *
 * 样例：
 *   Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-29T13:05:33Z
 *   Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-22T18:05:33Z
 *   Claude and GPT models\tWeekly Limit Remaining\t94%\t2026-11-25T13:28:08Z
 * ->
 *   { gemini: 100, claude: 94, score: 94, limits: [...] }
 *
 * 规则：
 *   - 优先按 tab 拆列；没有 tab（比如被换成了空格对齐）时，就在整行里找第一个 "xx%"
 *   - 同组多行取最小值（任何一个限额窗口耗尽，这组模型就用不了）
 *   - score = min(gemini, claude)；只解析到一组时用那一组；一组都没有时 score = null
 *     （由调用方当作失败处理，记 0 分）
 *
 * @param {string} text
 * @returns {{gemini: number|null, claude: number|null, score: number|null,
 *            limits: Array<{group: string, name: string, pct: number, resetAt: string|null}>}}
 */
export function parseUsage(text) {
  const groups = { gemini: null, claude: null };
  const limits = [];

  const lines = String(text ?? '').replace(ANSI_RE, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const group = GROUP_PATTERNS.find((g) => g.re.test(line));
    if (!group) continue;

    // 百分比：组名和限额名里都没有 "数字%"，所以取一行里第一个 "数字%" 是安全的
    const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) continue;
    const pct = clampPct(Number(m[1]));
    if (pct == null) continue;

    // 限额名和重置时间只用于观测，按 tab 列尽量取出来
    const cols = line.split('\t').map((s) => s.trim()).filter(Boolean);
    const name = cols.length >= 2 ? cols[1] : '';
    const resetMatch = line.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/);
    limits.push({ group: group.key, name, pct, resetAt: resetMatch ? resetMatch[0] : null });

    // 同组多个窗口取最小值
    groups[group.key] = groups[group.key] == null ? pct : Math.min(groups[group.key], pct);
  }

  const present = [groups.gemini, groups.claude].filter((v) => v != null);
  const score = present.length ? Math.min(...present) : null;
  return { gemini: groups.gemini, claude: groups.claude, score, limits };
}

/** 取字符串末尾一段，用于错误信息（避免把整屏 stderr 塞进日志） */
function tail(s, n = 300) {
  const t = String(s ?? '').replace(ANSI_RE, '').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

/**
 * 以指定 HOME 执行 `agy -p "/usage"`，返回 stdout。
 *
 * 为什么要改 HOME：agy 从 $HOME/.gemini/antigravity-cli/ 读 OAuth token，
 * 不设 HOME 就只能看到 /root（主脑1）的额度——这正是 spec 第一节缺陷 3 的原因。
 *
 * @param {string} home
 * @param {{agyBin?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<string>} 退出码 0 时 resolve stdout；否则 reject
 */
export function runUsage(home, { agyBin = 'agy', timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(agyBin, ['-p', '/usage'], {
        env: { ...env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'], // 不给 stdin，避免 agy 等交互输入
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    // 超时：直接 SIGKILL，并且以超时错误结束（之后的 close 事件会被 settled 拦下）
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程可能已经退出 */
      }
      finish(reject, new Error(`/usage timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d;
    });

    // spawn 失败（如 ENOENT：找不到 agy）会走 error 事件
    child.on('error', (err) => finish(reject, err));

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(resolve, stdout);
      } else {
        const why = tail(stderr) || tail(stdout) || 'no output';
        finish(reject, new Error(`/usage exited code=${code} signal=${signal ?? 'none'}: ${why}`));
      }
    });
  });
}

/** 读磁盘缓存文件，任何异常都当作空缓存 */
function readCacheFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== CACHE_FILE_VERSION || typeof data.entries !== 'object' || !data.entries) {
      return {};
    }
    const out = {};
    for (const [id, e] of Object.entries(data.entries)) {
      // 只接受结构完整的条目
      if (e && typeof e === 'object' && Number.isFinite(e.ts) && typeof e.home === 'string' && Number.isFinite(e.score)) {
        out[id] = e;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 创建额度缓存。
 *
 * @param {object} opts
 * @param {Array<{id: string, home: string, label?: string}>} opts.accounts  已校验过的账号表
 * @param {number}   [opts.ttlMs=300000]      成功结果 TTL
 * @param {number}   [opts.failTtlMs=60000]   失败结果 TTL
 * @param {number}   [opts.timeoutMs=15000]   单次 /usage 超时
 * @param {string}   [opts.agyBin='agy']      agy 可执行文件
 * @param {string|null} [opts.cacheFile=null] 磁盘缓存路径；null 表示只用内存
 * @param {Function} [opts.runner=runUsage]   (home, {agyBin, timeoutMs}) => Promise<string>；单测注入 mock 用
 * @param {Function} [opts.clock=Date.now]    时间源；单测注入用
 * @param {Function} [opts.log]               (msg: string) => void，人类可读日志
 */
export function createQuotaCache(opts = {}) {
  const {
    accounts = [],
    ttlMs = DEFAULT_TTL_MS,
    failTtlMs = DEFAULT_FAIL_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    agyBin = 'agy',
    cacheFile = null,
    runner = runUsage,
    clock = Date.now,
    log = () => {},
  } = opts;

  const list = accounts.filter((a) => a && typeof a.id === 'string' && a.id && typeof a.home === 'string' && a.home);

  /** @type {Map<string, object>} accountId -> 缓存条目 {ok, score, gemini, claude, limits, error, home, ts} */
  const entries = new Map();
  /** @type {Map<string, Promise<object>>} accountId -> 正在执行的刷新（去重用） */
  const inflight = new Map();

  /** 把磁盘缓存合并进内存：只采用比内存里更新的条目（其他 mux 进程可能刚刷新过） */
  function loadDisk() {
    if (!cacheFile) return;
    const disk = readCacheFile(cacheFile);
    for (const [id, e] of Object.entries(disk)) {
      const cur = entries.get(id);
      if (!cur || cur.ts < e.ts) entries.set(id, e);
    }
  }

  /** 写磁盘：先读后合并（保留别的进程写的更新条目），再 tmp+rename 原子替换 */
  function saveDisk() {
    if (!cacheFile) return;
    try {
      const merged = readCacheFile(cacheFile);
      for (const [id, e] of entries) {
        if (!merged[id] || merged[id].ts <= e.ts) merged[id] = e;
      }
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_FILE_VERSION, entries: merged }, null, 2));
      fs.renameSync(tmp, cacheFile);
    } catch (err) {
      log(`quota cache write failed (${cacheFile}): ${err?.message ?? err}`);
    }
  }

  /**
   * 条目是否还新鲜：
   *   - home 变了（账号表改过）→ 作废
   *   - 成功条目用 ttlMs，失败条目用 failTtlMs
   *   - age < 0（时钟回拨 / 别的机器写的未来时间）→ 视为过期
   */
  function isFresh(entry, acc) {
    if (!entry || entry.home !== acc.home) return false;
    const ttl = entry.ok ? ttlMs : failTtlMs;
    const age = clock() - entry.ts;
    return age >= 0 && age < ttl;
  }

  /**
   * 刷新单个账号。永远不 reject：失败时写入 score=0 的失败条目，
   * 这样 Promise.all 里一个账号挂了不会拖垮其他账号。
   */
  function refreshOne(acc) {
    const running = inflight.get(acc.id);
    if (running) return running; // 同一账号已经在查，复用同一个 Promise

    const p = (async () => {
      let entry;
      try {
        const text = await runner(acc.home, { agyBin, timeoutMs });
        const parsed = parseUsage(text);
        if (parsed.score == null) {
          throw new Error(`no quota lines in /usage output: ${tail(text, 200) || '(empty)'}`);
        }
        entry = { ok: true, score: parsed.score, gemini: parsed.gemini, claude: parsed.claude, limits: parsed.limits, error: null };
      } catch (err) {
        // 失败记 0 分：路由会因为 0 <= 10% 跳过它，但不影响其他账号
        entry = { ok: false, score: 0, gemini: null, claude: null, limits: [], error: String(err?.message ?? err) };
        log(`quota check failed account=${acc.id}: ${entry.error}`);
      }
      entry.home = acc.home;
      entry.ts = clock();
      entries.set(acc.id, entry);
      return entry;
    })().finally(() => inflight.delete(acc.id));

    inflight.set(acc.id, p);
    return p;
  }

  /**
   * 返回每个账号的额度分 {accountId: 0..100}。
   * 过期（或 force）的账号并发刷新，新鲜的直接用缓存。
   *
   * @param {{force?: boolean}} [o]
   * @returns {Promise<Record<string, number>>}
   */
  async function snapshot({ force = false } = {}) {
    loadDisk(); // 先看看其他 mux 进程是否已经刷新过
    const stale = list.filter((a) => force || !isFresh(entries.get(a.id), a));
    if (stale.length) {
      await Promise.all(stale.map(refreshOne)); // refreshOne 不会 reject
      saveDisk();
    }
    const out = {};
    for (const a of list) {
      const s = entries.get(a.id)?.score;
      out[a.id] = Number.isFinite(s) ? s : 0;
    }
    return out;
  }

  /**
   * 按组返回额度：{accountId: {gemini, claude, score}}。
   * 用于"按当前模型所属的组"选账号——只看 Claude 的任务不该被 Gemini 额度拖累。
   */
  async function snapshotByGroup({ force = false } = {}) {
    loadDisk();
    const stale = list.filter((a) => force || !isFresh(entries.get(a.id), a));
    if (stale.length) {
      await Promise.all(stale.map(refreshOne));
      saveDisk();
    }
    const out = {};
    for (const a of list) {
      const e = entries.get(a.id) ?? {};
      const g = Number.isFinite(e.gemini) ? e.gemini : 0;
      const c = Number.isFinite(e.claude) ? e.claude : 0;
      out[a.id] = { gemini: g, claude: c, score: Number.isFinite(e.score) ? e.score : Math.min(g, c) };
    }
    return out;
  }

  /** 各账号的完整缓存条目（含 gemini/claude 分组、错误原因），用于日志与报错 */
  function details() {
    const out = {};
    for (const a of list) {
      const e = entries.get(a.id);
      out[a.id] = e ? { ...e, limits: [...(e.limits ?? [])] } : null;
    }
    return out;
  }

  /** 作废某账号（或全部）的缓存，下次 snapshot() 会重新查询（故障转移后可调用） */
  function invalidate(accountId) {
    if (accountId == null) entries.clear();
    else entries.delete(accountId);
  }

  // 启动时读一次磁盘缓存（spec：启动时读额度缓存）
  loadDisk();

  return { snapshot, snapshotByGroup, details, invalidate };
}
