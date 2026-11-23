/**
 * 离线校验 dsh-dual-mirror 0.3.0（不需要启动 DSH、不需要模型）：
 *   [1] 子会话事件形状（真实 Session 构造器做 seed 校验）
 *   [2] 父会话写入边界（假 persistence / 假 parent）
 *   [3] catalog 载荷符合官方投影 schema
 *   [4] 工具入口（真实 apply：解析 DSH、自检、注册工具）
 *   [5] 错误路径
 *   [6] 回归：真实会话里 tool_call 与 tool_result 保持相邻，catalog 不进消息流
 *   [7] 输入卫生：长度上限、控制字符、零宽/双向字符、密钥脱敏
 *   [8] 记录文件逐字导入 + 来源标注
 *   [9] 幂等去重 / catalog 重试 / 降级导出
 *
 * 运行：node test/verify.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-mirror-test-'))
process.env.DSH_HOME = TMP

const DSH_INSTALL = process.env.DSH_INSTALL_ROOT || '/usr/local/lib/node_modules/@deepseek-ai/dsh'
const { Session } = await import(`${DSH_INSTALL}/node_modules/@deepseek-ai/dsh-session/lib/index.js`)
const {
  buildMirrorSession, normalizeArgs, parseTranscript, sanitizeText, redactSecrets,
  dialogHash, DEFAULT_SPEAKERS,
} = await import('../lib/mirror.js')
const { writeMirrorSession, exportMarkdown, avatarsAvailable, readAvatarRefs, readIndex, webpSize } = await import('../lib/store.js')
const { apply } = await import('../lib/index.js')
const { compareVersions, resolveDshRoot } = await import('../lib/adapter.js')

let failures = 0
let total = 0
const ok = (name, cond, extra = '') => {
  total += 1
  if (cond) console.log(`  ✓ ${name}`)
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`) }
}
const throws = async (name, fn, needle = '') => {
  try {
    await fn()
    ok(name, false, '应当抛错但没有')
  } catch (error) {
    ok(name, String(error.message).includes(needle), `→ ${error.message}`)
  }
}

const parentHeader = {
  version: 4,
  id: 'session-parent-0001',
  createdAt: 1794000000000,
  cwd: '/root/dsh-projects',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}
const messages = [
  { role: 'user', text: '你好，我是 DSH。' },
  { role: 'assistant', text: '收到，我是 Antigravity。' },
  { role: 'user', text: '我们讨论一下镜像方案。' },
  { role: 'assistant', text: '好。' },
]
const PROVENANCE = '✍️ 来源：由模型整理，非逐字记录'

console.log('\n[1] 子会话事件形状（真实 Session 构造器）')
const built = buildMirrorSession({ parentHeader, label: '镜像测试', messages, provenance: PROVENANCE, now: 1794000000001 })
let session
try {
  session = Session.create(built.header.id, built.events, built.header, 0, [])
  const logged = JSON.parse(JSON.stringify(session.log)).map((event) => event.type)
  const seeded = logged.slice(0, built.events.length)
  ok('Session.create 接受全部事件', seeded.every((type, i) => type === built.events[i].type), logged.join(','))
  ok('seed 末尾自动补 session/end-seed', logged[logged.length - 1] === 'session/end-seed', logged.join(','))
} catch (error) {
  failures += 1
  console.error(`  ✗ Session.create 拒绝事件：${error.message}`)
}
ok('header.origin = subagent', built.header.origin === 'subagent')
ok('header.parentSession 指向父会话', built.header.parentSession === parentHeader.id)
ok('delegationDepth = 父 + 1', built.header.delegationDepth === 1)
ok('首事件是 descriptor', built.events[0].type === 'subagent/descriptor')
ok('descriptor: version 3 / one-shot / provider', built.events[0].data.version === 3 && built.events[0].data.mode === 'one-shot' && built.events[0].data.provider === 'dsh-dual-mirror')
ok('首条气泡标注来源', built.events[1].data.content[1].text.includes('✍️ 来源'))
ok('消息事件全部是 user/message', built.events.slice(1).every((e) => e.type === 'user/message'))
ok('没有伪造 assistant/message', built.events.every((e) => e.type !== 'assistant/message'))
ok('消息都带 surfaceOp:append', built.events.slice(1).every((e) => e.surfaceOp === 'append'))
ok('seq 连续', built.events.every((e, i) => e.seq === i))
ok('每条消息含头像 + 文本块', built.events.slice(1).every((e) => e.data.content[0].type === 'image' && e.data.content[1].type === 'text'))
ok('消息 data.role 固定 user（视觉靠头像区分）', built.events.slice(1).every((e) => e.data.role === 'user' && e.data.source.kind === 'user'))
const noAvatar = buildMirrorSession({ parentHeader, label: 'x', messages, provenance: PROVENANCE, avatars: false })
ok('头像缺失时可退化为纯文字块', noAvatar.events.slice(1).every((e) => e.data.content.length === 1 && e.data.content[0].type === 'text'))

console.log('\n[2] 父会话写入边界（假 persistence / 假 parent）')
const parentAppends = []
const fakeParent = { header: parentHeader, append(type, data) { parentAppends.push({ type, data }); return { seq: parentAppends.length } } }
const created = { header: null, events: null, flushed: false, closed: false }
const knownIds = new Set()
const fakePersistence = {
  async create(header) {
    created.header = header
    knownIds.add(header.id)
    return {
      async append(events) { created.events = events },
      async flush() { created.flushed = true },
      async close() { created.closed = true },
    }
  },
  async stat(id) { return knownIds.has(id) ? { id } : undefined },
}
const result = await writeMirrorSession(
  { parent: fakeParent, persistence: fakePersistence, dshHome: TMP, logger: { warn() {} } },
  { label: '镜像测试', messages, speakers: DEFAULT_SPEAKERS, provenance: PROVENANCE },
)
ok('返回 childSessionId', result.childSessionId === created.header.id)
ok('消息全部写进子会话', created.events.length === 2 + messages.length && created.events.filter((e) => e.type === 'user/message').length === messages.length + 1)
ok('flush + close 都执行', created.flushed && created.closed)
ok('父会话只有一次 append', parentAppends.length === 1, `实际 ${parentAppends.length}`)
ok('那次 append 是 subagent/catalog', parentAppends[0]?.type === 'subagent/catalog', parentAppends[0]?.type)
ok('父会话没有 user/message / assistant/message', parentAppends.every((a) => a.type !== 'user/message' && a.type !== 'assistant/message'))

console.log('\n[3] catalog 载荷符合官方投影 schema（version 0 / one-shot / label）')
const catalog = parentAppends[0]?.data ?? {}
const catalogKeys = Object.keys(catalog).sort().join(',')
ok('字段集合 = childCreatedAt,childId,label,mode,version（version 0）', catalogKeys === 'childCreatedAt,childId,label,mode,version', catalogKeys)
ok('childId 与子会话一致', catalog.childId === created.header.id)
ok('childCreatedAt 与 header 一致', catalog.childCreatedAt === created.header.createdAt)
ok('mode = one-shot', catalog.mode === 'one-shot')
ok('label 是字符串', typeof catalog.label === 'string' && catalog.label.length > 0)

console.log('\n[4] 工具入口（真实 apply：解析 DSH、自检、注册工具）')
const registered = []
const fakeCtx = {
  sessionPersistence: fakePersistence,
  logger: { info() {}, warn() {} },
  get(name) { return this[name] },
  tools: { register(tool) { registered.push(tool) } },
}
await apply(fakeCtx)
ok('注册 mirror_agent_dialog', registered.length === 1 && registered[0].name === 'mirror_agent_dialog')
const tool = registered[0]
const fakeExec = { agent: { session: { header: parentHeader, append: fakeParent.append.bind(fakeParent) } } }
parentAppends.length = 0
const toolResult = await tool.execute({ label: '工具测试', messages: [{ role: 'user', text: 'hi' }] }, fakeExec)
ok('工具返回 stage=done', toolResult.stage === 'done')
ok('工具返回 mode=session', toolResult.mode === 'session')
ok('工具返回 childSessionId', typeof toolResult.childSessionId === 'string' && toolResult.childSessionId.startsWith('session-'))
ok('工具执行后父会话仍只有一条 catalog', parentAppends.length === 1 && parentAppends[0].type === 'subagent/catalog')

const targetAppends = []
const targetSession = { header: { ...parentHeader, id: 'session-target-0001' }, append(type, data) { targetAppends.push({ type, data }); return { seq: 1 } } }
const routedTools = []
await apply({
  sessionPersistence: fakePersistence,
  sessions: { get(id) { return id === targetSession.header.id ? targetSession : undefined } },
  logger: { info() {}, warn() {} },
  get(name) { return this[name] },
  tools: { register(t) { routedTools.push(t) } },
})
const routed = await routedTools[0].execute({ label: '定向挂号', messages: [{ role: 'user', text: 'route me' }], targetSessionId: targetSession.header.id }, fakeExec)
ok('targetSessionId：卡片登记到目标会话', routed.mode === 'session' && targetAppends.length === 1 && targetAppends[0].type === 'subagent/catalog')
ok('targetSessionId：child header 的 parentSession 指向目标会话', created.header && created.header.parentSession === targetSession.header.id)
await throws('targetSessionId 找不到会话要报错', async () => routedTools[0].execute({ label: 'x', messages: [{ role: 'user', text: 'x' }], targetSessionId: 'session-missing' }, fakeExec), '找不到目标会话')

console.log('\n[5] 错误路径')
await throws('messages 为空要报错', async () => normalizeArgs({ label: 'x', messages: [] }), 'messages 为空')
await throws('父会话 cwd 缺失要报错', async () => buildMirrorSession({ parentHeader: { id: 'p', cwd: undefined }, label: 'x', messages }), 'cwd')
await throws('非绝对 cwd 要报错', async () => buildMirrorSession({ parentHeader: { id: 'p', cwd: 'relative/dir' }, label: 'x', messages }), 'cwd')
const degradedTools = []
await apply({ tools: { register(t) { degradedTools.push(t) } }, logger: { info() {}, warn() {} } })
const degraded = await degradedTools[0].execute({ label: 'x', messages }, fakeExec)
ok('缺少 sessionPersistence 时降级导出而非报错', degraded.mode === 'export' && typeof degraded.exportedPath === 'string' && degraded.stage === 'degraded')
await throws('persistence 失败时带 child id 报错', async () => writeMirrorSession(
  { parent: fakeParent, persistence: { async create() { throw new Error('disk full') } }, dshHome: TMP, logger: { warn() {} } },
  { label: 'x', messages, speakers: DEFAULT_SPEAKERS, provenance: PROVENANCE },
), 'stage=create')

console.log('\n[6] 回归：tool_call 与 tool_result 保持相邻，catalog 不进消息流')
function makeHistoryParent() {
  const parent = Session.create('session-history-test', [], {
    version: 4, id: 'session-history-test', createdAt: 1, cwd: '/root/dsh-projects', isSeeded: false, delegationDepth: 0,
  }, 0, [])
  parent.append('user/message', { id: 'm-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开始' }] }, { surfaceOp: 'append' })
  parent.append('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: 'm-assistant', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'tool-call', id: 'call-1', name: 'mirror_agent_dialog', arguments: {} }],
    },
    stream: {},
  }, { surfaceOp: 'append' })
  const call = parent.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'mirror_agent_dialog', arguments: {} })
  return { parent, callSeq: call.seq }
}
const adjacent = (list) => {
  const assistant = list.findIndex((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool-call'))
  return assistant >= 0 && list[assistant + 1]?.role === 'tool'
}
const parentAppendsScripted = []
const realParent = makeHistoryParent()
const realParentSession = realParent.parent
const scriptedSession = {
  header: realParentSession.header,
  append(type, data, options) {
    parentAppendsScripted.push(type)
    return realParentSession.append(type, data, options)
  },
}
await writeMirrorSession(
  { parent: scriptedSession, persistence: fakePersistence, dshHome: TMP, logger: { warn() {} } },
  { label: '回归', messages: [{ role: 'user', text: '记录这段' }], speakers: DEFAULT_SPEAKERS, provenance: PROVENANCE },
)
realParentSession.append('tool/result', {
  turn: 1, step: 1,
  message: {
    id: 'm-result', role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' },
    content: [{ type: 'text', text: '已写入子会话' }],
  },
}, { surfaceOp: 'append', sourceEventSeqs: [realParent.callSeq] })
const newMessages = realParentSession.deriveMessages()
ok('新实现：模型消息序列 = user → assistant(tool-call) → tool', JSON.stringify(newMessages.map((m) => m.role)) === JSON.stringify(['user', 'assistant', 'tool']), JSON.stringify(newMessages.map((m) => m.role)))
ok('新实现：tool_call 与 tool_result 相邻', adjacent(newMessages))
ok('新实现：catalog 不在模型消息里', !JSON.stringify(newMessages).includes('subagent/catalog'))

const oldParent = makeHistoryParent()
oldParent.parent.append('user/message', { id: 'm-old', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧实现插入的气泡' }] }, { surfaceOp: 'append' })
oldParent.parent.append('tool/result', {
  turn: 1, step: 1,
  message: { id: 'm-result-old', role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] },
}, { surfaceOp: 'append', sourceEventSeqs: [oldParent.callSeq] })
const oldMessages = oldParent.parent.deriveMessages()
ok('旧实现：模型消息里 user 插在 assistant 与 tool 之间', JSON.stringify(oldMessages.map((m) => m.role)) === JSON.stringify(['user', 'assistant', 'user', 'tool']), JSON.stringify(oldMessages.map((m) => m.role)))
ok('旧实现：相邻性断言会失败（证明回归测试有效）', adjacent(oldMessages) === false)

console.log('\n[7] 输入卫生：长度、控制字符、零宽/双向字符、密钥脱敏')
ok('剥掉控制字符', sanitizeText('a\u0000b\u0007c') === 'abc')
ok('剥掉零宽与双向覆盖字符', sanitizeText('a\u200Bb\u202Ec\uFEFF') === 'abc')
ok('保留换行', sanitizeText('l1\nl2') === 'l1\nl2')
ok('API key 脱敏', redactSecrets('key sk-abcdefghijklmnop1234567890 end') === 'key [REDACTED] end')
ok('私钥块脱敏', redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----') === '[REDACTED]')
ok('Bearer token 脱敏', redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456') === 'Authorization: [REDACTED]')
const longText = 'x'.repeat(9000)
const limited = normalizeArgs({ label: 'l'.repeat(200), messages: [{ role: 'user', text: longText }] })
ok('label 截断到 80 字符', limited.label.length === 80)
ok('单条消息截断到 8000 字符且带标记', limited.messages[0].text.length === 8000 && limited.messages[0].text.endsWith('…[已截断]'))
ok('消息条数上限生效', normalizeArgs({ label: 'x', messages: Array.from({ length: 300 }, () => ({ role: 'user', text: 'a' })) }).messages.length === 200)

console.log('\n[8] 记录文件逐字导入 + 来源标注')
const transcript = `# 双 Agent 对话记录

> 2026-11-17 ｜ 测试

---

## DSH → Antigravity

请评审第 7 节。

---

## Antigravity → DSH

第 7 节有两处事实错误。
`
writeFileSync(join(TMP, 'transcript.md'), transcript)
const parsed = parseTranscript(transcript)
ok('解析出 2 条消息', parsed.messages.length === 2)
ok('角色正确（user / assistant）', parsed.messages[0].role === 'user' && parsed.messages[1].role === 'assistant')
ok('正文完整', parsed.messages[1].text.includes('两处事实错误'))
ok('标题解析', parsed.title === '双 Agent 对话记录')
const withThinking = parseTranscript(`# t

## DSH → Antigravity

正文问题

### 附带推理片段

先想想，再回答

### 工具活动

- grep 一次
`)
ok('思考与工具活动被拆成独立段', withThinking.messages.length === 3 && withThinking.messages[1].kind === 'thinking' && withThinking.messages[2].kind === 'tools')
ok('思考段正文保留', withThinking.messages[1].text === '先想想，再回答')
const cwdParent = { header: { ...parentHeader, cwd: TMP }, append() { return { seq: 0 } } }
const imported = await tool.execute({ label: '导入测试', transcriptPath: 'transcript.md' }, { agent: { session: cwdParent } })
ok('工具能按路径导入', imported.mode === 'session' && imported.appended === 3)

console.log('\n[9] 幂等去重 / catalog 重试 / 降级导出')
const dedupePayload = { label: '去重', messages: [{ role: 'user', text: 'same content' }], speakers: DEFAULT_SPEAKERS, provenance: PROVENANCE }
const first = await writeMirrorSession({ parent: fakeParent, persistence: fakePersistence, dshHome: TMP, logger: { warn() {} } }, dedupePayload)
const second = await writeMirrorSession({ parent: fakeParent, persistence: fakePersistence, dshHome: TMP, logger: { warn() {} } }, dedupePayload)
ok('相同内容第二次返回 deduped', second.mode === 'deduped' && second.childSessionId === first.childSessionId)
ok('索引里记录了 catalog 已登记', readIndex(TMP).entries[dialogHash(dedupePayload)]?.catalogRegistered === true)
let flaky = 0
const flakyParent = {
  header: parentHeader,
  append(type, data) {
    flaky += 1
    if (flaky === 1) throw new Error('transient')
    return { seq: flaky }
  },
}
await writeMirrorSession({ parent: flakyParent, persistence: fakePersistence, dshHome: TMP, logger: { warn() {} } }, { label: '重试', messages: [{ role: 'user', text: 'retry case' }], speakers: DEFAULT_SPEAKERS, provenance: PROVENANCE })
ok('catalog 失败一次后自动重试成功', flaky === 2)
const exported = exportMarkdown({ dshHome: TMP, payload: { label: '导出', provenance: PROVENANCE, speakers: DEFAULT_SPEAKERS, messages: [{ role: 'user', text: 'hi' }] } })
ok('导出文件存在', readFileSync(exported.path, 'utf8').includes('未写入会话'))
ok('导出内容含来源与发言方', readFileSync(exported.path, 'utf8').includes('✍️ 来源') && readFileSync(exported.path, 'utf8').includes('DSH'))

console.log('\n[10] 适配层')
ok('版本比较：rc 小于正式版', compareVersions('0.2.2-rc.1', '0.2.2') < 0)
ok('版本比较：rc.1 小于 rc.2', compareVersions('0.2.2-rc.1', '0.2.2-rc.2') < 0)
ok('能定位 DSH 安装根目录', typeof resolveDshRoot() === 'string')
ok('头像附件检查返回布尔', typeof avatarsAvailable(TMP) === 'boolean')
const avatarRoot = process.env.DSH_AVATAR_ROOT || join(process.env.HOME || '/root', '.dsh')
if (existsSync(avatarRoot)) {
  const realAvatars = readAvatarRefs(avatarRoot)
  ok('头像按文件读出 32×32', realAvatars?.user?.attachment?.width === 32 && realAvatars.user.attachment.height === 32 && realAvatars.user.attachment.bytes > 0)
  if (realAvatars !== undefined) {
    const sample = buildMirrorSession({ parentHeader, label: 'x', messages, avatars: realAvatars })
    ok('头像引用写进消息块', sample.events[1].data.content[0].attachment.width === 32)
  }
} else {
  console.log('  - 跳过头像用例：本机没有 ' + avatarRoot + '（可用 DSH_AVATAR_ROOT 指定）')
}

rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? `\n全部通过 ✅（${total} 项）` : `\n失败 ${failures}/${total} 项 ❌`)
process.exit(failures === 0 ? 0 : 1)
