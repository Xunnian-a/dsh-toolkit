/**
 * 写入层：会话落盘、catalog 登记、幂等索引、降级导出。
 *
 * 红线（事故复盘）：父会话只允许一次 `subagent/catalog`；任何消息都只进子会话。
 * 评审 P0-2 的诉求：对话内容要能标出来源（逐字导入 / 模型整理 / 记录文件）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { buildMirrorSession, dialogHash, LIMITS, renderMarkdownExport } from './mirror.js'

/** 读 WebP 头得到真实像素尺寸（readImage 会核对尺寸，写错就渲染失败）。 */
export function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return {
      width: 1 + (buffer.readUIntLE(24, 3) & 0xffffff),
      height: 1 + (buffer.readUIntLE(27, 3) & 0xffffff),
    }
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  return undefined
}

const INDEX_VERSION = 1
const INDEX_MAX_ENTRIES = 200

/** DSH 数据根目录（与运行时一致）。 */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 头像附件是否在附件库里（评审 P1-2：缺失时退化为只写名字）。 */
export function avatarsAvailable(dshHome = resolveDshHome()) {
  return readAvatarRefs(dshHome) !== undefined
}

/**
 * 按磁盘上的真实文件生成头像引用（尺寸必须与文件一致，否则服务端 readImage 校验失败）。
 * @returns {{user: object, assistant: object}|undefined}
 */
export function readAvatarRefs(dshHome = resolveDshHome()) {
  const make = (hex, name) => {
    const file = join(dshHome, 'attachments/v1/objects', hex.slice(0, 2), hex)
    if (!existsSync(file)) return undefined
    const buffer = readFileSync(file)
    const size = webpSize(buffer)
    if (size === undefined) return undefined
    return {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${hex}`,
        mediaType: 'image/webp',
        width: size.width,
        height: size.height,
        bytes: buffer.length,
        name,
      },
    }
  }
  const user = make('dd57affee4b2eb5b2998613a919641c83735c506f3b6c0d8bd438e4bb9573462', 'dsh-avatar-32.webp')
  const assistant = make('b1ae6436f8c191985c7e5ab6f2ae148f881065745e7b034dca787ab02a4fd507', 'ag-avatar-32.webp')
  return user === undefined || assistant === undefined ? undefined : { user, assistant }
}

function mirrorDir(dshHome) {
  return join(dshHome, 'dual-mirror')
}

function indexPath(dshHome) {
  return join(mirrorDir(dshHome), 'index.json')
}

/** 读取幂等索引；坏文件按空索引处理（不能因为索引坏了就写不了会话）。 */
export function readIndex(dshHome = resolveDshHome()) {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(dshHome), 'utf8'))
    if (parsed?.version === INDEX_VERSION && parsed.entries !== null && typeof parsed.entries === 'object') return parsed
  } catch { /* 不存在或损坏都重建 */ }
  return { version: INDEX_VERSION, entries: {} }
}

/** 原子写入幂等索引（临时文件 + rename），并裁剪到最近 N 条。 */
export function writeIndex(index, dshHome = resolveDshHome()) {
  const entries = Object.entries(index.entries ?? {})
    .sort((a, b) => (b[1]?.createdAt ?? 0) - (a[1]?.createdAt ?? 0))
    .slice(0, INDEX_MAX_ENTRIES)
  const payload = { version: INDEX_VERSION, entries: Object.fromEntries(entries) }
  const file = indexPath(dshHome)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return payload
}

/**
 * 读取记录文件并做路径约束：必须存在、必须是普通文件、大小受限、默认必须在会话 cwd 之下。
 *
 * @param {{cwd: string, path: string, allowOutsideCwd?: boolean, dshHome?: string}} input
 * @returns {{text: string, path: string}} 文件内容与解析后的真实路径
 */
export function readTranscriptFile({ cwd, path, allowOutsideCwd = false }) {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('transcriptPath 为空')
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const real = (() => {
    try {
      return statSync(target).isFile() ? target : undefined
    } catch {
      return undefined
    }
  })()
  if (real === undefined) throw new Error(`记录文件不存在或不是普通文件：${target}`)
  const size = statSync(real).size
  if (size > LIMITS.transcriptBytes) throw new Error(`记录文件过大（${size} 字节 > ${LIMITS.transcriptBytes}）`)
  if (!allowOutsideCwd) {
    const rel = relative(resolve(cwd), real)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`记录文件必须位于会话工作目录内：${real}`)
  }
  return { text: readFileSync(real, 'utf8'), path: real }
}

/**
 * 写入一条镜像子会话。
 *
 * @param {object} deps
 * @param {object} deps.parent 父会话（真实 Session）
 * @param {object} deps.persistence sessionPersistence 服务
 * @param {object} [deps.index] 预读的索引（测试注入）
 * @param {string} [deps.dshHome]
 * @param {{warn: Function}} [deps.logger]
 * @param {Function} [deps.build] 事件构造器（测试可注入）
 * @param {Function} [deps.hash] 指纹函数（测试可注入）
 * @param {boolean} [deps.avatars]
 * @param {object} input
 * @returns {Promise<{mode: 'session'|'deduped', childSessionId: string, appended: number}>}
 */
export async function writeMirrorSession(deps, input) {
  const {
    parent,
    persistence,
    dshHome = resolveDshHome(),
    logger = console,
    build = buildMirrorSession,
    hash = dialogHash,
    avatars = avatarsAvailable(dshHome),
  } = deps

  const fingerprint = hash(input)
  const index = deps.index ?? readIndex(dshHome)
  const existing = input.force === true ? undefined : index.entries[fingerprint]

  if (existing !== undefined) {
    const known = await persistence.stat(existing.childSessionId).catch(() => undefined)
    if (known !== undefined) {
      if (existing.catalogRegistered !== true) await registerCatalog(parent, existing.childSessionId, existing.childCreatedAt, existing.label, logger)
      return { mode: 'deduped', childSessionId: existing.childSessionId, appended: 0 }
    }
    delete index.entries[fingerprint]
  }

  const { header, events } = build({ ...input, parentHeader: parent.header, avatars })
  let handle
  let stage = 'create'
  try {
    handle = await persistence.create(header)
    stage = 'append'
    await handle.append(events)
    stage = 'flush'
    await handle.flush()
  } catch (error) {
    throw new Error(`子会话写入失败（stage=${stage}, child=${header.id}）：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (error) {
        logger.warn(`[dsh-dual-mirror] 子会话 ${header.id} close 失败（内容已 flush，读取时持久化层会修复尾部）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  index.entries[fingerprint] = {
    childSessionId: header.id,
    childCreatedAt: header.createdAt,
    label: input.label,
    createdAt: Date.now(),
    catalogRegistered: false,
  }
  writeIndex(index, dshHome)

  try {
    await registerCatalog(parent, header.id, header.createdAt, input.label, logger)
    index.entries[fingerprint].catalogRegistered = true
  } finally {
    writeIndex(index, dshHome)
  }

  return { mode: 'session', childSessionId: header.id, appended: events.length - 1 }
}

/**
 * 父会话唯一允许的写入：一条 catalog；失败重试一次（评审 P2）。
 */
async function registerCatalog(parent, childId, childCreatedAt, label, logger) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      parent.append('subagent/catalog', {
        version: 0,
        childId,
        childCreatedAt,
        mode: 'one-shot',
        label: String(label ?? '').trim() || '双 Agent 对话',
      })
      return
    } catch (error) {
      if (attempt === 2) {
        logger.warn(`[dsh-dual-mirror] catalog 登记失败（child=${childId}），子会话已落盘，可用清理脚本处理：${error instanceof Error ? error.message : String(error)}`)
        throw new Error(`子会话已写入（${childId}），但父会话 catalog 登记失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * 降级模式：自检失败时不写会话，导出一份 Markdown（评审 P1-1）。
 *
 * @param {object} input
 * @param {string} input.dshHome
 * @param {object} input.payload {label, provenance, speakers, messages}
 * @param {number} [input.now]
 * @returns {{path: string}}
 */
export function exportMarkdown({ dshHome, payload, now = Date.now() }) {
  const dir = join(mirrorDir(dshHome), 'exports')
  mkdirSync(dir, { recursive: true })
  const slug = String(payload.label ?? 'dialog').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dialog'
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}-${slug}.md`)
  writeFileSync(file, renderMarkdownExport({ ...payload, createdAt: now }), { mode: 0o600 })
  return { path: file }
}
