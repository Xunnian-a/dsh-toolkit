#!/usr/bin/env node
/**
 * 列出 / 清理 dsh-dual-mirror 生成的镜像子会话。
 *
 * 默认只读：从 $DSH_HOME/dual-mirror/index.json 读登记表，核对当前是否存在，
 * 输出 id / 标题 / 父会话 / 登记状态。删除必须显式给 id 且加 --yes，绝不自动删。
 *
 * 用法：
 *   node scripts/mirror-sessions.mjs
 *   node scripts/mirror-sessions.mjs --json
 *   node scripts/mirror-sessions.mjs --remove <childSessionId> --yes
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const indexPath = join(dshHome, 'dual-mirror', 'index.json')
const sessionsRoot = join(dshHome, 'sessions')

function readIndex() {
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
    return parsed?.entries ?? {}
  } catch {
    return {}
  }
}

/** 在一级目录（cwd 桶）下找 session-<id> 目录并返回路径。 */
function findSessionDir(childSessionId) {
  if (!existsSync(sessionsRoot)) return undefined
  for (const bucket of readdirSync(sessionsRoot)) {
    const candidate = join(sessionsRoot, bucket, childSessionId)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return undefined
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return '?'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const removeIndex = args.indexOf('--remove')
const removeId = removeIndex === -1 ? undefined : args[removeIndex + 1]
const confirmed = args.includes('--yes')
const entries = Object.entries(readIndex())

if (removeId !== undefined) {
  const hit = entries.find(([, value]) => value.childSessionId === removeId)
  if (hit === undefined) {
    console.error(`登记表里没有 ${removeId}；为避免误删，只允许删除本插件登记过的子会话。`)
    process.exit(2)
  }
  const dir = findSessionDir(removeId)
  if (dir === undefined) {
    console.error(`磁盘上找不到 ${removeId}（可能已被清理）。`)
    process.exit(2)
  }
  console.log(`将删除：${dir}`)
  console.log(`标题：${hit[1].label} ｜ 父会话登记状态：${hit[1].catalogRegistered === true ? '已登记' : '未登记（孤儿卡片）'}`)
  if (!confirmed) {
    console.log('\n未加 --yes，未删除。确认后重跑：')
    console.log(`  node scripts/mirror-sessions.mjs --remove ${removeId} --yes`)
    process.exit(1)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log('已删除。注意：父会话里的卡片事件不会被改写，UI 里可能留一张打不开的卡片。')
  process.exit(0)
}

const rows = entries.map(([hash, value]) => {
  const dir = findSessionDir(value.childSessionId)
  return {
    childSessionId: value.childSessionId,
    label: value.label ?? '',
    createdAt: formatTime(value.createdAt),
    catalogRegistered: value.catalogRegistered === true,
    exists: dir !== undefined,
    path: dir,
    hash: hash.slice(0, 12),
  }
}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))

if (json) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}
if (rows.length === 0) {
  console.log(`没有登记过的镜像子会话（${indexPath}）。`)
  process.exit(0)
}
console.log(`共 ${rows.length} 条镜像子会话（${indexPath}）：\n`)
for (const row of rows) {
  console.log(`- ${row.childSessionId}`)
  console.log(`  标题：${row.label} ｜ 创建：${row.createdAt} ｜ 卡片：${row.catalogRegistered ? '已登记' : '未登记'} ｜ 文件：${row.exists ? '在' : '已丢失'}`)
  if (row.path !== undefined) console.log(`  路径：${row.path}`)
}
console.log('\n删除（需显式 id + --yes）：node scripts/mirror-sessions.mjs --remove <childSessionId> --yes')
