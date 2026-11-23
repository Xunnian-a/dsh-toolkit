window.__ModuleLoader__.load({
  id: 'dsh-jev-supervisor',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-jev-supervisor'
    const PANEL_ID = 'dsh-jev-supervisor'
    const ROUTE = '/api/dsh-jev-supervisor/status'
    const STYLE_ID = 'dsh-jev-supervisor/panel.css'
    const STATE_ICON = {
      COMPLETED: '✅', WAITING: '⏸️', FAILED: '❌', CANCELLED: '⛔', EXECUTING: '▶️',
      VALIDATING: '🧪', REVIEWING: '🔍', REVISING: '🔁', PLANNING: '🗺️', ANALYZING: '🔎', CREATED: '🆕',
    }

    const css = [
      '.jevStatus{display:grid;gap:12px;padding:16px;height:100%;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}',
      '.jevStatus_header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}',
      '.jevStatus_title{margin:0;font-size:15px;font-weight:600}',
      '.jevStatus_sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.jevStatus_actions{display:flex;gap:6px;align-items:center}',
      '.jevStatus_btn{appearance:none;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font:inherit;cursor:pointer}',
      '.jevStatus_btn:disabled{opacity:.5;cursor:default}',
      '.jevStatus_list{display:grid;gap:8px;margin:0;padding:0;list-style:none}',
      '.jevStatus_item{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25));border-radius:8px;padding:8px 10px;display:grid;gap:4px;min-width:0}',
      '.jevStatus_row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.jevStatus_id{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.jevStatus_state{font-size:12px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.15));white-space:nowrap}',
      '.jevStatus_meta{color:var(--dsw-alias-label-tertiary);font-size:12px;display:flex;flex-wrap:wrap;gap:2px 10px}',
      '.jevStatus_quota{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.jevStatus_note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.jevStatus_error{color:var(--dsw-alias-danger,#c0392b);font-size:12px;margin:0}',
      '.jevStatus_empty{color:var(--dsw-alias-label-tertiary);padding:8px 0;margin:0}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = css
      document.head.appendChild(element)
    }

    function RailIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, h('rect', { x: 4, y: 3.5, width: 16, height: 17, rx: 2.5 }), h('path', { d: 'M8 8h8M8 12h8M8 16h5' }))
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (number) => String(number).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function taskRow(task) {
      const meta = []
      if (task.route) meta.push(`route ${task.route}`)
      meta.push(`${task.round}/${task.maxRounds} 轮`)
      if (task.commit) meta.push(String(task.commit).slice(0, 7))
      if (task.updatedAt) meta.push(formatTime(task.updatedAt))
      return h('li', { className: 'jevStatus_item', key: task.taskId },
        h('div', { className: 'jevStatus_row' },
          h('span', { 'aria-hidden': 'true' }, STATE_ICON[task.state] || '•'),
          h('span', { className: 'jevStatus_id', title: task.taskId }, task.taskId),
          h('span', { className: 'jevStatus_state' }, task.state)),
        h('div', { className: 'jevStatus_meta' }, meta.map((item, index) => h('span', { key: index }, item))))
    }

    function Panel() {
      ensureStyle()
      const [payload, setPayload] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(ROUTE, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error((data && data.error) || `HTTP ${response.status}`)
          }
          setPayload(data)
          setError('')
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 10_000)
        return () => clearInterval(timer)
      }, [load])

      const tasks = payload !== null && Array.isArray(payload.tasks) ? payload.tasks : []
      const groups = payload !== null && payload.quota !== null && Array.isArray(payload.quota.groups) ? payload.quota.groups : []
      return h('section', { className: 'jevStatus', 'aria-label': 'jev-supervisor 任务状态' },
        h('header', { className: 'jevStatus_header' },
          h('div', null,
            h('h2', { className: 'jevStatus_title' }, 'jev-supervisor'),
            h('p', { className: 'jevStatus_sub' }, loading ? '读取中…' : `最近 ${tasks.length} 个任务`)),
          h('div', { className: 'jevStatus_actions' },
            h('button', {
              type: 'button', className: 'jevStatus_btn', onClick: load, disabled: loading, title: '立即刷新',
            }, '刷新'))),
        error === '' ? null : h('p', { className: 'jevStatus_error' }, `读取失败：${error}`),
        tasks.length === 0 && error === '' ? h('p', { className: 'jevStatus_empty' }, '还没有任务记录（var/*.wal.json）') : null,
        h('ul', { className: 'jevStatus_list' }, tasks.map(taskRow)),
        groups.length === 0 ? null : h('p', { className: 'jevStatus_quota' },
          '额度：' + groups.map((group) => `${group.name} ${group.fiveHourPct}%`).join(' · ')),
        h('p', { className: 'jevStatus_note' }, '每 10 秒自动刷新；数据来自 jev-supervisor 的 WAL。'))
    }

    function apply(ctx) {
      const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
      const close = () => {
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      }
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 12,
        label: 'jev-supervisor',
      }, RailIcon)), 'dsh-jev-supervisor: rail icon')
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, () => h(Panel, { onClose: close }))), 'dsh-jev-supervisor: main panel')
    }

    return { NS, PANEL_ID, inject: ['slots', 'layout'], apply, Panel, RailIcon }
  },
})
