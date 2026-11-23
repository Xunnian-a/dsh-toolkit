/** 路径约束：所有由模型给出的路径都必须落在 workspace / allowedRoots 之内。 */
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** target 是否在 root 之内（含 root 本身）。两边都应是绝对路径。 */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 解析 workspace 内的路径（相对路径按 workspace 解析）。
 * 不做真实路径归一化——调用方需要时再用 realpathInside 校验符号链接。
 */
export function resolveInWorkspace(workspace, value, label = 'path') {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 不能为空`)
  const root = resolve(workspace)
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value)
  if (!isInside(root, target)) throw new Error(`${label} 必须位于 workspace 内（${root}），收到：${value}`)
  return target
}

/** 解析一个必须已存在的文件，并用真实路径再校验一次（防符号链接逃逸）。 */
export function resolveExistingInWorkspace(workspace, value, label = 'path') {
  const target = resolveInWorkspace(workspace, value, label)
  if (!existsSync(target)) throw new Error(`${label} 不存在：${target}`)
  const realRoot = realpathSync(workspace)
  const realTarget = realpathSync(target)
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`${label} 的真实路径逃出了 workspace（${realTarget}）`)
  }
  return realTarget
}

/**
 * 校验一个路径落在任一允许根目录内，返回真实路径。
 * 不存在的路径按字面解析（用于计划输出文件这类即将创建的目标）。
 */
export function assertUnderRoots(roots, value, label = 'path') {
  const target = resolve(value)
  const real = existsSync(target) ? realpathSync(target) : target
  for (const root of roots) {
    const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
    if (isInside(realRoot, real)) return real
  }
  throw new Error(`${label} 不在允许的根目录内（${roots.join(', ')}）：${value}`)
}
