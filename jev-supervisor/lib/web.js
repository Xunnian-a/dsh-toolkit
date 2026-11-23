/** Web 状态卡片的只读 JSON 路由：GET /api/dsh-jev-supervisor/status。 */
import { collectTasks } from './status.js'

export const STATUS_ROUTE = '/api/dsh-jev-supervisor/status'

export function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function createStatusHandler({ connection, workspace, readQuota }) {
  return async (req, res) => {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) return respond(res, rejection, { ok: false, error: 'access-denied' })
      if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
      const tasks = collectTasks(workspace, { limit: 20 })
      let quota
      try {
        quota = await readQuota()
      } catch {
        quota = undefined
      }
      return respond(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        tasks,
        quota: quota ?? null,
      })
    } catch {
      return respond(res, 500, { ok: false, error: 'status-failed' })
    }
  }
}
