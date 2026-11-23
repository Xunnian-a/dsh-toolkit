/**
 * dsh-dual-mirror 0.3.0 — 把 DSH 与外部 agent 的对话录成一条「子会话」，供 Web UI 浏览。
 *
 * 设计红线（2026-11-16 事故后确立）：只往子会话里写。父会话里唯一允许出现的是一条
 * `subagent/catalog` 发现事件（内置 task 工具用来挂子会话卡片的同款元数据），
 * 它不进入消息流、不会被模型看到。
 *
 * 绝不允许：
 *   - `parent.append('user/message' | 'assistant/message', …)`
 *     —— 工具调用进行中插入消息会让历史变成 tool_call → user message → tool_result，
 *        模型接口拒绝，该会话之后每一轮都 TRANSPORT 失败。
 *   - 伪造「正在跑的 agent」：子会话是纯静态记录。
 *
 * 0.3.0 按外部评审 P0/P1/P2 修订：
 *   - P0-1 真实会话回归测试（见 test/verify.mjs [6]）
 *   - P0-2 内容来源可追溯：transcriptPath 逐字导入 / 明确标注「由模型整理」
 *   - P1-1 内部契约集中到 adapter.js，启动自检失败降级为 Markdown 导出
 *   - P1-2 头像附件缺失时退化为只写名字
 *   - P1-3 输入长度上限、控制字符清洗、常见密钥脱敏
 *   - P2   去掉死参数 cwd、内容指纹幂等、catalog 失败重试一次、close 失败记日志
 */
import { relative } from 'node:path'
import {
  exportMarkdown,
  readAvatarRefs,
  readTranscriptFile,
  resolveDshHome,
  writeMirrorSession,
} from './store.js'
import { buildMirrorSession, normalizeArgs, normalizeSpeakers, parseTranscript } from './mirror.js'
import { loadDshModules, resolveDshRoot, runSelfCheck } from './adapter.js'

export const name = 'dsh-dual-mirror'
export const inject = ['tools', 'sessionPersistence']

const PROVENANCE_MODEL = '✍️ 来源：由模型整理，非逐字记录'
const provenanceFile = (path) => `📄 来源：${path}（从记录文件逐字导入）`

/**
 * 形状探针：用真实 Session 构造器 dry-run 一组样例事件。
 * 任何内部形状变化都会在这里先炸，而不是等到写坏会话之后。
 */
function probeShapes(Session) {
  const sample = buildMirrorSession({
    parentHeader: { id: 'session-shape-probe', cwd: '/tmp', delegationDepth: 0, agentPreset: 'standard' },
    label: '形状探测',
    messages: [{ role: 'user', text: 'probe' }, { role: 'assistant', text: 'ok' }],
    provenance: PROVENANCE_MODEL,
    now: 1,
  })
  Session.create(sample.header.id, sample.events, sample.header, 0, [])
}

export async function apply(ctx) {
  const root = resolveDshRoot()
  if (root === undefined) throw new Error('[dsh-dual-mirror] 找不到 DSH 安装目录，插件无法加载')

  let defineTool
  let Session
  try {
    ({ defineTool, Session } = await loadDshModules(root))
  } catch (error) {
    throw new Error(`[dsh-dual-mirror] 加载 DSH 内部模块失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const selfCheck = runSelfCheck({ root, Session, probe: probeShapes })
  const dshHome = resolveDshHome()
  const avatarRefs = readAvatarRefs(dshHome)
  const logger = ctx.logger ?? console

  logger.info?.(`[dsh-dual-mirror] DSH ${selfCheck.version ?? 'unknown'} ｜ 自检 ${selfCheck.ok ? '通过' : '失败（降级为 Markdown 导出）'} ｜ 头像 ${avatarRefs === undefined ? '缺失，退化为纯文字' : `${avatarRefs.user.attachment.width}×${avatarRefs.user.attachment.height}`}`)
  for (const warning of selfCheck.warnings) logger.warn?.(`[dsh-dual-mirror] ${warning}`)
  for (const failure of selfCheck.failures) logger.warn?.(`[dsh-dual-mirror] 自检失败：${failure}`)

  /** 把一次调用需要的对话内容解析出来（记录文件优先，其次模型给的 messages）。 */
  function resolvePayload(args, parent) {
    const cwd = parent.header.cwd
    const speakers = normalizeSpeakers({ speakers: args?.speakers })

    if (typeof args?.transcriptPath === 'string' && args.transcriptPath.trim() !== '') {
      const file = readTranscriptFile({ cwd, path: args.transcriptPath.trim() })
      const parsed = parseTranscript(file.text)
      if (parsed.messages.length === 0) throw new Error('记录文件里没有解析出对话（期望 "## DSH → Antigravity" 这类分节）')
      const { messages, label } = normalizeArgs({
        label: args?.label ?? parsed.title ?? '双 Agent 对话',
        messages: parsed.messages,
      })
      return { label, messages, speakers, provenance: provenanceFile(relative(cwd, file.path) || file.path) }
    }

    const { label, messages } = normalizeArgs({ label: args?.label, messages: args?.messages })
    return { label, messages, speakers, provenance: PROVENANCE_MODEL }
  }

  ctx.tools.register(defineTool({
    name: 'mirror_agent_dialog',
    description:
      '把一段 DSH ↔ 外部 agent 的对话录成当前会话下的一条可浏览子会话（只读卡片）。'
      + '优先用 transcriptPath 从记录文件逐字导入；只给 messages 时会标注「由模型整理，非逐字记录」。',
    parameters: {
      label: { type: 'string', description: '卡片标题（子会话名）。' },
      messages: {
        type: 'array',
        description: '对话消息；与 transcriptPath 二选一。由模型提供的正文会在子会话里标注为「模型整理」。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, enum: ['user', 'assistant'], description: 'user = 本侧，assistant = 外部 agent。' },
            text: { type: 'string', required: true, description: '消息正文。' },
          },
        },
      },
      targetSessionId: {
        type: 'string',
        description: '可选：把卡片登记到指定会话（默认当前会话）。子 agent 想往父会话挂卡片时用它。',
      },
      transcriptPath: {
        type: 'string',
        description: '记录文件路径（相对会话 cwd 或绝对路径且必须在 cwd 之下），逐字导入；支持 dual-dialog 的 "## A → B" 分节格式。',
      },
      force: {
        type: 'boolean',
        description: '可选：跳过内容指纹去重，强制新写一条子会话（用于重录同一段对话）。',
      },
      speakers: {
        type: 'object',
        additionalProperties: false,
        description: '可选的发言方显示名，默认 DSH / Antigravity。',
        properties: {
          user: { type: 'string', description: '本侧名字。' },
          assistant: { type: 'string', description: '外部 agent 名字。' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          childSessionId: { type: 'string' },
          exportedPath: { type: 'string' },
          appended: { type: 'number', required: true },
          stage: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.mode === 'export'
          ? `自检未通过，已导出 Markdown：${v.exportedPath}`
          : v.mode === 'deduped'
            ? `内容未变，复用已有子会话 ${v.childSessionId}`
            : `已写入子会话 ${v.childSessionId}（${v.appended} 条消息）`,
      }],
    },
    async execute(args, exec) {
      const targetId = typeof args?.targetSessionId === 'string' && args.targetSessionId.trim() !== ''
        ? args.targetSessionId.trim()
        : undefined
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
      const parent = targetId === undefined ? exec.agent?.session : sessions?.get?.(targetId)
      if (!parent) {
        throw new Error(targetId === undefined
          ? 'mirror_agent_dialog 需要一个所属 agent 会话'
          : `找不到目标会话 ${targetId}（不在线或 ID 不对）`)
      }

      const payload = resolvePayload(args, parent)
      const persistence = ctx.sessionPersistence

      if (!selfCheck.ok || persistence === undefined) {
        const exported = exportMarkdown({ dshHome, payload })
        logger.warn?.(`[dsh-dual-mirror] 未写会话，已导出 ${exported.path}（原因：${selfCheck.ok ? 'sessionPersistence 不可用' : selfCheck.failures.join('；')}）`)
        return { mode: 'export', exportedPath: exported.path, appended: 0, stage: 'degraded' }
      }

      const result = await writeMirrorSession({ parent, persistence, dshHome, logger, avatars: avatarRefs ?? false }, { ...payload, force: args?.force === true })
      return { ...result, stage: 'done' }
    },
  }))
}
