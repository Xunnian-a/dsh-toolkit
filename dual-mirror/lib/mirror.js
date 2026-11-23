import { createHash, randomUUID } from 'node:crypto'

/**
 * 纯函数层：把对话整理成镜像子会话的 header / 事件序列 / 导出文本。
 *
 * 这一层不碰 DSH 服务，便于离线校验；所有写会话的动作在 store.js。
 * 红线：这里只会生成 `user/message` 与 `subagent/descriptor`，绝不生成
 * `assistant/message`；父会话不在这一层出现。
 */

export const CONTRACT = Object.freeze({
  sessionFormat: 4,
  descriptorVersion: 3,
  catalogVersion: 0,
  provider: 'dsh-dual-mirror',
})

/** 输入上限：防止一次调用把超长内容灌进会话（评审 P1-3）。 */
export const LIMITS = Object.freeze({
  labelChars: 80,
  messages: 200,
  messageChars: 8000,
  totalChars: 120000,
  transcriptBytes: 2 * 1024 * 1024,
})

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const ZERO_WIDTH = /[\u200B-\u200F\u2028\u2029\uFEFF]/g
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g

/** 去掉控制字符、零宽字符与双向覆盖字符；保留换行与制表。 */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(ZERO_WIDTH, '')
    .replace(BIDI_CONTROL, '')
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,20}PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}/gi,
]

/** 落盘前对常见密钥格式做脱敏（评审 P1-3；JSONL 是明文存储）。 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

/** 截断到指定字符数，超限时带可见标记。 */
export function truncate(text, max) {
  const value = String(text ?? '')
  const marker = '…[已截断]'
  if (value.length <= max) return value
  if (max <= marker.length) return marker.slice(0, max)
  return value.slice(0, max - marker.length) + marker
}

/** 默认发言方名字；可通过工具参数覆盖（评审 P2：为将来接入其他 agent 预留）。 */
export const DEFAULT_SPEAKERS = Object.freeze({ user: 'DSH', assistant: 'Antigravity' })

/** 32×32 头像的附件引用（内容寻址，文件可能不在库中，见 store.avatarsAvailable）。 */
export const AVATARS = Object.freeze({
  user: {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:dd57affee4b2eb5b2998613a919641c83735c506f3b6c0d8bd438e4bb9573462',
      mediaType: 'image/webp', width: 32, height: 32, bytes: 742, name: 'dsh-avatar-32.webp',
    },
  },
  assistant: {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:b1ae6436f8c191985c7e5ab6f2ae148f881065745e7b034dca787ab02a4fd507',
      mediaType: 'image/webp', width: 32, height: 32, bytes: 758, name: 'ag-avatar-32.webp',
    },
  },
})

/** 规整发言方显示名（默认 DSH / Antigravity）。 */
export function normalizeSpeakers(args) {
  return {
    user: truncate(sanitizeText(args?.speakers?.user ?? '').trim(), 40) || DEFAULT_SPEAKERS.user,
    assistant: truncate(sanitizeText(args?.speakers?.assistant ?? '').trim(), 40) || DEFAULT_SPEAKERS.assistant,
  }
}

/**
 * 校验并规整工具入参。
 *
 * @param {object} args 工具参数
 * @returns {{label: string, messages: Array<{role: 'user'|'assistant', text: string}>, speakers: {user: string, assistant: string}}}
 */
export function normalizeArgs(args, limits = LIMITS) {
  const label = truncate(sanitizeText(String(args?.label ?? '').trim()), limits.labelChars) || '双 Agent 对话'
  const raw = Array.isArray(args?.messages) ? args.messages : []
  const messages = []
  let total = 0
  for (const item of raw) {
    if (messages.length >= limits.messages) break
    const text = truncate(redactSecrets(sanitizeText(item?.text ?? '')).trim(), limits.messageChars)
    if (text === '') continue
    if (total + text.length > limits.totalChars) break
    total += text.length
    const kind = item?.kind === 'thinking' || item?.kind === 'tools' || item?.kind === 'permission' ? item.kind : 'body'
    messages.push({ role: item?.role === 'assistant' ? 'assistant' : 'user', text, kind })
  }
  if (messages.length === 0) throw new Error('messages 为空：至少给一条非空 text（或用 transcriptPath 指定记录文件）')
  return { label, messages, speakers: normalizeSpeakers(args) }
}

/**
 * 解析 dual-dialog 记录文件（本机脚本 notes/dual-dialog-*.md 的格式）：
 * `## DSH → Antigravity` / `## Antigravity → DSH` 分节，正文到下一个 `---` 或 `##` 结束。
 *
 * @param {string} text 文件内容
 * @returns {{title?: string, messages: Array<{role: 'user'|'assistant', text: string}>}}
 */
export function parseTranscript(text) {
  const source = String(text ?? '')
  const titleMatch = source.match(/^#\s+(.+)$/m)
  const messages = []
  const section = /^##\s+(.+?)\s*(?:→|->)\s*(.+?)\s*$/gm
  const matches = [...source.matchAll(section)]
  for (let i = 0; i < matches.length; i += 1) {
    const from = matches[i][1].trim().toLowerCase()
    const role = from === 'antigravity' || from === 'assistant' ? 'assistant' : 'user'
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length
    let body = source.slice(start, end)
    body = body.split(/^\s*---\s*$/m)[0]
    body = body.replace(/^\s*\n/, '').trimEnd()
    for (const part of splitSectionParts(body)) {
      if (part.text.trim() === '') continue
      messages.push({ role, kind: part.kind, text: part.text.trim() })
    }
  }
  return { ...titleMatch === undefined ? {} : { title: titleMatch[1].trim() }, messages }
}

/** 把一节正文按 `### 附带推理片段` / `### 工具活动` 拆成若干段（思考与正文分开展示）。 */
function splitSectionParts(body) {
  const parts = []
  let current = { kind: 'body', lines: [] }
  for (const line of String(body).split('\n')) {
    const heading = line.match(/^###\s+(.+?)\s*$/)
    if (heading !== null) {
      if (current.lines.length > 0) parts.push(current)
      current = { kind: kindFromHeading(heading[1]), lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.length > 0) parts.push(current)
  return parts
    .map((part) => ({ kind: part.kind, text: part.lines.join('\n').trim() }))
    .filter((part) => part.text !== '')
}

/** 把记录文件里的三级标题映射成展示类型。 */
function kindFromHeading(heading) {
  if (/推理|思考|thinking/i.test(heading)) return 'thinking'
  if (/工具活动|工具调用|tool/i.test(heading)) return 'tools'
  if (/权限/.test(heading)) return 'permission'
  return 'body'
}

/** 展示名前缀：思考 / 工具 / 权限单独标注，和正式发言分开。 */
const KIND_LABEL = Object.freeze({
  thinking: '💭 思考',
  tools: '🔧 工具活动',
  permission: '🔐 权限请求',
})

/**
 * 构造镜像子会话的 header 与事件。
 *
 * @param {object} input
 * @param {object} input.parentHeader 父会话 header（取 id / cwd / delegationDepth / agentPreset）
 * @param {string} input.label 卡片标题
 * @param {Array<{role: string, text: string}>} input.messages 对话消息
 * @param {string} [input.provenance] 来源说明（写入首条气泡，明确是逐字导入还是模型整理）
 * @param {{user: string, assistant: string}} [input.speakers] 发言方名字
 * @param {boolean|{user: object, assistant: object}} [input.avatars] 是否附带头像块；也可传真实引用（含正确尺寸）
 * @param {number} [input.now] 时间戳（测试注入）
 * @returns {{childId: string, header: object, events: object[]}}
 */
export function buildMirrorSession({
  parentHeader,
  label,
  messages,
  provenance,
  speakers = DEFAULT_SPEAKERS,
  avatars = true,
  now = Date.now(),
}) {
  const title = String(label ?? '').trim() || '双 Agent 对话'
  const parentCwd = parentHeader?.cwd
  if (typeof parentCwd !== 'string' || !parentCwd.startsWith('/')) {
    throw new Error(`父会话缺少绝对 cwd（得到 ${String(parentCwd)}），无法为子会话生成存储路径`)
  }
  const childId = `session-${randomUUID()}`
  const createdAt = Number.isSafeInteger(now) ? now : Date.now()
  const header = {
    version: CONTRACT.sessionFormat,
    id: childId,
    createdAt,
    cwd: parentCwd,
    parentSession: parentHeader.id,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: (Number.isSafeInteger(parentHeader.delegationDepth) ? parentHeader.delegationDepth : 0) + 1,
    ...parentHeader.agentPreset === undefined ? {} : { agentPreset: parentHeader.agentPreset },
  }

  const events = [{
    type: 'subagent/descriptor',
    seq: 0,
    time: createdAt,
    data: { version: CONTRACT.descriptorVersion, mode: 'one-shot', provider: CONTRACT.provider, label: title },
  }]

  const avatarFor = (role) => {
    if (avatars === true) return AVATARS[role]
    if (avatars === false || avatars === undefined) return undefined
    return avatars?.[role]
  }
  const push = (text, role, kind = 'body') => {
    const avatar = avatarFor(role)
    const name = kind !== 'body' && KIND_LABEL[kind] !== undefined
      ? `${role === 'assistant' ? speakers.assistant : speakers.user} · ${KIND_LABEL[kind]}`
      : role === 'assistant' ? speakers.assistant : speakers.user
    events.push({
      type: 'user/message',
      seq: events.length,
      time: createdAt + events.length,
      surfaceOp: 'append',
      data: {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [
          ...avatar === undefined ? [] : [avatar],
          { type: 'text', text: `${name}\n\n${text}` },
        ],
      },
    })
  }

  if (typeof provenance === 'string' && provenance.trim() !== '') push(provenance.trim(), 'user')
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = String(message?.text ?? '').trim()
    if (text === '') continue
    push(text, message?.role === 'assistant' ? 'assistant' : 'user', message?.kind ?? 'body')
  }
  return { childId, header, events }
}

/** 对话内容指纹：用于幂等（重试不重复造子会话）。 */
export function dialogHash({ label, provenance, speakers, messages }) {
  const canonical = JSON.stringify({
    label: label ?? '',
    provenance: provenance ?? '',
    speakers: speakers ?? DEFAULT_SPEAKERS,
    messages: (Array.isArray(messages) ? messages : []).map((m) => [m?.role === 'assistant' ? 'assistant' : 'user', m?.kind ?? 'body', String(m?.text ?? '')]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** 降级模式导出的 Markdown 全文。 */
export function renderMarkdownExport({ label, provenance, speakers, messages, createdAt = Date.now() }) {
  const lines = [
    `# ${label || '双 Agent 对话'}`,
    '',
    `> 导出时间：${new Date(createdAt).toISOString()} ｜ 由 dsh-dual-mirror 导出（未写入会话）`,
    ...provenance ? [`> ${provenance}`] : [],
    '',
    '---',
    '',
  ]
  for (const message of Array.isArray(messages) ? messages : []) {
    lines.push(`## ${message.role === 'assistant' ? speakers.assistant : speakers.user}`)
    lines.push('')
    lines.push(message.text)
    lines.push('')
    lines.push('---')
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
