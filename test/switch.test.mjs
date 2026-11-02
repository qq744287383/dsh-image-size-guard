import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Drive the switch the way a user does: render the row, click its switch, and
 * assert the exact payload that reaches the Host.
 *
 * The render tests prove the switch exists and carries the right state. This
 * proves clicking it asks the Host to save the row with `enabled` inverted and
 * every other field preserved — the wiring between the control and storage.
 */

// ---- React shim -----------------------------------------------------------
const hooks = { state: [], index: 0 }
function useState(initial) {
  const index = hooks.index++
  if (hooks.state.length <= index) hooks.state[index] = typeof initial === 'function' ? initial() : initial
  return [
    hooks.state[index],
    (next) => {
      hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next
    },
  ]
}
globalThis.__REACT_STUB__ = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false),
  }),
  useState,
  useEffect() {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
globalThis.__DOCUMENT_STUB__ = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
}

const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
let exports
new Function('window', 'document', source)(
  { __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => globalThis.__REACT_STUB__) } } },
  globalThis.__DOCUMENT_STUB__,
)

let Section
const ctx = {
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (_options, component) => {
      Section = component
      return () => {}
    },
  },
}
exports.apply(ctx)

/** Collect every element in the tree, expanding function components. */
function collect(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    collect(node.type(node.props), out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

/** Render the section with a fresh hook cursor, the way a new mount would. */
function render(props) {
  hooks.index = 0
  return Section(props)
}

const row = {
  provider: 'agent2api',
  maxRequestBytes: 16 * 1024 * 1024,
  reserveBytes: 256 * 1024,
  placeholderBytes: 512,
  enabled: true,
}

// ---- clicking an enabled row's switch asks to disable it ----
{
  hooks.state = [{ status: 'ready', providers: [row], advertised: [] }, undefined, false, '']
  const calls = []
  const tree = render({
    t: (key) => key,
    rpcCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { providers: [{ ...row, enabled: false }] } }
    },
  })

  const switchButton = collect(tree).find((node) => node.props.role === 'switch')
  assert.ok(switchButton, 'the row renders a switch')
  assert.equal(switchButton.props['aria-checked'], true)

  switchButton.props.onClick()
  // The handler is async; let its microtasks settle.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 1, 'one request per click')
  assert.equal(calls[0].endpoint, 'limits.save')
  assert.deepEqual(calls[0].payload.limit, { ...row, enabled: false }, 'the payload is the row with the flag inverted')
}

// ---- clicking a disabled row's switch asks to enable it ----
{
  const disabled = { ...row, enabled: false }
  hooks.state = [{ status: 'ready', providers: [disabled], advertised: [] }, undefined, false, '']
  const calls = []
  const tree = render({
    t: (key) => key,
    rpcCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { providers: [{ ...row, enabled: true }] } }
    },
  })

  const switchButton = collect(tree).find((node) => node.props.role === 'switch')
  assert.equal(switchButton.props['aria-checked'], false)

  switchButton.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls[0].endpoint, 'limits.save')
  assert.equal(calls[0].payload.limit.enabled, true)
  assert.equal(calls[0].payload.limit.maxRequestBytes, 16 * 1024 * 1024, 'the limit is carried through untouched')
}

// ---- a refused toggle surfaces an error instead of flipping silently ----
{
  hooks.state = [{ status: 'ready', providers: [row], advertised: [] }, undefined, false, '']
  const tree = render({
    t: (key) => key,
    rpcCall: async () => ({ ok: false, error: { code: 'failed', message: 'storage is read-only' } }),
  })
  const switchButton = collect(tree).find((node) => node.props.role === 'switch')
  switchButton.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  // The component stores the message; the row state is only replaced on success.
  const stored = hooks.state[3]
  assert.equal(stored, 'storage is read-only', 'the Host message reaches the user')
  assert.equal(hooks.state[0].providers[0].enabled, true, 'a failed toggle does not fake success')
}

// ---- the switch is disabled while a save is in flight ----
{
  hooks.state = [{ status: 'ready', providers: [row], advertised: [] }, undefined, true, '']
  const tree = render({ t: (key) => key, rpcCall: async () => ({ ok: true, value: { providers: [] } }) })
  const switchButton = collect(tree).find((node) => node.props.role === 'switch')
  assert.equal(switchButton.props.disabled, true, 'a busy row cannot be toggled twice')
}

console.log('all switch wiring tests passed')
