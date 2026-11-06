import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Render the settings section to a string through a minimal React shim.
 *
 * This does not try to be React: it runs the component functions the bundle
 * defines, so the assertions below are about the real element tree the panel
 * builds — its text, its classes, and its handlers — rather than about the
 * source looking plausible.
 */

// ---- React shim -----------------------------------------------------------
const hooks = { state: [], index: 0 }
function useState(initial) {
  const index = hooks.index++
  if (hooks.state.length <= index) hooks.state[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next
  }
  return [hooks.state[index], set]
}
function useCallback(fn) {
  return fn
}
function useMemo(fn) {
  return fn()
}
function useEffect() {}

globalThis.__REACT_STUB__ = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false),
  }),
  useState,
  useEffect,
  useCallback,
  useMemo,
}

let elementId = 0
globalThis.__DOCUMENT_STUB__ = {
  getElementById: () => null,
  createElement: () => ({ id: `el-${elementId++}`, textContent: '' }),
  head: { appendChild: () => {} },
}

/** Run a component function with fresh hooks and return its element tree. */
function renderComponent(component, props) {
  hooks.index = 0
  return component(props)
}

/** Flatten an element tree into readable text. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join(' ')
}

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

/** Find elements whose className contains a marker. */
function byClass(tree, marker) {
  return collect(tree).filter((node) => String(node.props.className ?? '').includes(marker))
}

/** Find buttons by their rendered label. */
function button(tree, label) {
  return collect(tree).find((node) => node.type === 'button' && textOf(node).trim() === label)
}

// ---- load the bundle ------------------------------------------------------
const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
let exports
new Function('window', 'document', source)(
  {
    __ModuleLoader__: {
      load({ factory }) {
        exports = factory(() => globalThis.__REACT_STUB__)
      },
    },
  },
  globalThis.__DOCUMENT_STUB__,
)

// Capture the section component and its injected props.
let options
let Section
const ctx = {
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  connection: { rpc: { call: async () => ({ ok: true, value: { providers: [], advertised: [] } }) } },
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (registration, component) => {
      // Only the Settings page is under test here; the Turn-tail notice also
      // registers into a slot, and capturing it would shadow this one.
      if (registration.name !== 'settings.section') return () => {}
      options = registration
      Section = component
      return () => {}
    },
  },
}
exports.apply(ctx)

const t = (key) => key

// ---- the empty state explains what to do ----
{
  hooks.state = []
  const tree = renderComponent(Section, { t, rpcCall: async () => ({ ok: true, value: { providers: [], advertised: ['agent2api'] } }) })
  const text = textOf(tree)
  assert.ok(text.includes('intro'), 'the page states what it does')
  // Loading is the first paint, because the list arrives over RPC.
  assert.ok(byClass(tree, 'dsg-empty').length >= 1, 'a first paint shows a placeholder rather than a blank page')
}

// ---- a populated list renders one row per provider ----
{
  const providers = [
    { provider: 'agent2api', maxRequestBytes: 16 * 1024 * 1024, reserveBytes: 256 * 1024, placeholderBytes: 512, enabled: true },
    { provider: 'openscg', maxRequestBytes: 8 * 1024 * 1024, reserveBytes: 1024, placeholderBytes: 256, enabled: false },
  ]
  // Seed the list state the way a resolved load would.
  hooks.state = [{ status: 'ready', providers, advertised: ['agent2api', 'openscg', 'third'] }, undefined, false, '']
  const tree = renderComponent(Section, { t, rpcCall: async () => ({ ok: true, value: { providers, advertised: [] } }) })

  const rows = collect(tree).filter((node) => String(node.props.className ?? '').split(' ').includes('dsg-row'))
  assert.equal(rows.length, 2, 'one row per provider')

  const text = textOf(tree)
  assert.ok(text.includes('agent2api'))
  assert.ok(text.includes('openscg'))
  assert.ok(text.includes('16.0 MiB'), 'the limit is formatted for humans')
  assert.ok(text.includes('15.8 MiB'), 'the effective budget is shown alongside it')

  // Each row carries a switch whose state is exposed to assistive tech.
  const switches = collect(tree).filter((node) => node.props.role === 'switch')
  assert.equal(switches.length, 2, 'one switch per provider')
  assert.equal(switches[0].props['aria-checked'], true, 'the enabled row is on')
  assert.equal(switches[1].props['aria-checked'], false, 'the disabled row is off')
  assert.ok(textOf(switches[0]).includes('enabledOn'))
  assert.ok(textOf(switches[1]).includes('enabledOff'))
  // The switch is a button, so Enter and Space activate it without extra code.
  assert.equal(switches[0].type, 'button')
  assert.equal(typeof switches[0].props.onClick, 'function', 'clicking the switch flips the row')

  // The disabled row is also visually muted, not just labelled.
  const offRows = collect(tree).filter((node) => String(node.props.className ?? '').includes('dsg-row-off'))
  assert.equal(offRows.length, 1, 'the disabled row carries its own style hook')

  // Each row offers edit and remove.
  assert.ok(button(tree, 'edit'), 'every row can be edited')
  assert.ok(button(tree, 'remove'), 'every row can be removed')

  // A provider the registry advertises but no row covers is offered as a shortcut.
  assert.ok(text.includes('third'), 'advertised-but-unconfigured providers are suggested')
}

// ---- the add form validates before it calls the Host ----
{
  hooks.state = [{ status: 'ready', providers: [], advertised: [] }, { provider: '' }, false, '']
  const calls = []
  const tree = renderComponent(Section, {
    t,
    rpcCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { providers: [] } }
    },
  })

  const form = collect(tree).find((node) => node.type === 'form')
  assert.ok(form, 'the add form renders')

  // Submitting with a blank provider is rejected client-side.
  form.props.onSubmit({ preventDefault() {} })
  assert.equal(calls.length, 0, 'nothing is sent for an invalid form')
}

// ---- the edit form is pre-filled with the row it edits ----
{
  const limit = { provider: 'agent2api', maxRequestBytes: 16 * 1024 * 1024, reserveBytes: 256 * 1024, placeholderBytes: 512, enabled: true }
  hooks.state = [{ status: 'ready', providers: [limit], advertised: [] }, limit, false, '']
  const tree = renderComponent(Section, { t, rpcCall: async () => ({ ok: true, value: { providers: [limit] } }) })

  const inputs = collect(tree).filter((node) => node.type === 'input')
  const values = inputs.map((node) => node.props.value).filter((value) => value !== undefined)
  assert.ok(values.includes('agent2api'), 'the provider name is pre-filled')

  // Each size is shown in the unit its field names, so nobody has to convert
  // bytes in their head before editing.
  assert.ok(values.includes('16'), 'the limit is pre-filled in MiB')
  assert.ok(values.includes('256'), 'the reserve is pre-filled in KiB')
  assert.ok(values.includes('512'), 'the placeholder size is pre-filled in bytes')
  assert.equal(values.includes(String(16 * 1024 * 1024)), false, 'raw bytes are not shown')

  // The labels carry the unit, so a bare number is unambiguous.
  const labels = collect(tree)
    .filter((node) => String(node.props.className ?? '').includes('dsg-label'))
    .map((node) => textOf(node))
  assert.ok(labels.some((label) => /\(MiB\)/.test(label)), 'the limit field names MiB')
  assert.ok(labels.some((label) => /\(KiB\)/.test(label)), 'the reserve field names KiB')

  const providerInput = inputs.find((node) => node.props.value === 'agent2api')
  assert.equal(providerInput.props.disabled, true, 'a provider route cannot be renamed in place')
}

// ---- editing in units saves exact bytes ----
{
  const limit = { provider: 'agent2api', maxRequestBytes: 16 * 1024 * 1024, reserveBytes: 256 * 1024, placeholderBytes: 512, enabled: true }
  hooks.state = [{ status: 'ready', providers: [limit], advertised: [] }, limit, false, '']
  const calls = []
  const tree = renderComponent(Section, {
    t,
    rpcCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { providers: [payload?.limit ?? limit] } }
    },
  })

  const form = collect(tree).find((node) => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 1, 'the form submitted')
  const saved = calls[0].payload.limit
  assert.equal(saved.maxRequestBytes, 16 * 1024 * 1024, 'MiB is converted back to exact bytes')
  assert.equal(saved.reserveBytes, 256 * 1024, 'KiB is converted back to exact bytes')
  assert.equal(saved.placeholderBytes, 512, 'bytes are stored as typed')
  // Batch policy travels with the row and keeps its shipped defaults.
  assert.equal(saved.targetTurns, 5, 'the default headroom is five turns')
  assert.equal(saved.minFillPercent, 40, 'the default low-water mark is forty percent')
  assert.equal(saved.protectedTurns, 2, 'the two newest turns stay protected by default')
  assert.equal(saved.growthWindow, 8, 'growth is sampled over eight turns')
}

// ---- the batch policy is editable and saved as whole numbers ----
{
  const limit = {
    provider: 'agent2api',
    maxRequestBytes: 16 * 1024 * 1024,
    reserveBytes: 256 * 1024,
    placeholderBytes: 512,
    targetTurns: 0,
    minFillPercent: 55,
    protectedTurns: 4,
    growthWindow: 6,
    enabled: true,
  }
  hooks.state = [{ status: 'ready', providers: [limit], advertised: [] }, limit, false, '']
  const calls = []
  const tree = renderComponent(Section, {
    t,
    rpcCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { providers: [payload?.limit ?? limit] } }
    },
  })

  const values = collect(tree).filter((node) => node.type === 'input').map((node) => node.props.value)
  assert.ok(values.includes('0'), 'a disabled batch prefills as zero turns')
  assert.ok(values.includes('55'), 'the low-water mark prefills in percent')
  assert.ok(values.includes('4'), 'the protected tail prefills')
  assert.ok(values.includes('6'), 'the growth window prefills')

  const labels = collect(tree)
    .filter((node) => String(node.props.className ?? '').includes('dsg-label'))
    .map((node) => textOf(node))
  assert.ok(labels.some((label) => label.includes('targetTurns')), 'the batch group is labelled')
  assert.ok(labels.some((label) => label.includes('protectedTurns')))

  collect(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  const saved = calls[0].payload.limit
  assert.equal(saved.targetTurns, 0)
  assert.equal(saved.minFillPercent, 55)
  assert.equal(saved.protectedTurns, 4)
  assert.equal(saved.growthWindow, 6)
}

// ---- every visible string comes from the locale dictionaries ----
{
  const dicts = {}
  const localCtx = {
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (ns, value) => {
        Object.assign(dicts, value)
        return () => {}
      },
      bind: () => (key) => key,
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    slots: { inject: (_k, callback) => { callback(); return () => {} }, register: () => () => {} },
  }
  exports.apply(localCtx)
  assert.ok(dicts.zh && dicts.en, 'both locales are registered')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), 'the dictionaries cover the same keys')
  for (const [key, value] of Object.entries(dicts.en)) {
    assert.ok(typeof value === 'string' && value.length > 0, `en.${key} is non-empty`)
  }
  // Units and protocol names stay in their conventional form in every locale.
  const untranslated = new Set(['mib', 'bytes'])
  for (const [key, value] of Object.entries(dicts.zh)) {
    assert.ok(typeof value === 'string' && value.length > 0, `zh.${key} is non-empty`)
    if (untranslated.has(key)) continue
    assert.ok(/[\u4e00-\u9fff]/.test(value), `zh.${key} is actually translated`)
  }
}

console.log('all client render tests passed')
