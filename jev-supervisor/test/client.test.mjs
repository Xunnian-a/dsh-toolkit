import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client 注册侧边栏图标与 main 面板', () => {
  let definition
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value } } },
    document: { getElementById: () => ({}) },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, tasks: [] }) }),
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  assert.equal(definition.id, 'dsh-jev-supervisor')
  const React = {
    createElement: (...args) => ({ args }),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const module = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })

  const injected = []
  const registered = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'layout' ? { selectPanel: () => {} } : undefined),
    slots: {
      inject: (name, callback) => { injected.push(name); callback(); return () => {} },
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    },
  }
  module.apply(ctx)

  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
  assert.equal(registered.find((entry) => entry.spec.name === 'main').spec.key, 'dsh-jev-supervisor')
  assert.equal(registered.find((entry) => entry.spec.name === 'sidebar.panellist').spec.id, 'dsh-jev-supervisor')
  assert.equal(typeof module.RailIcon, 'function')
  const tree = module.Panel()
  assert.equal(tree.args[0], 'section')
})
