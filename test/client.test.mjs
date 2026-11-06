import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Load the browser bundle the way `window.__ModuleLoader__` does: hand it a
 * `require` that returns React, and capture what it returns.
 *
 * The bundle is plain browser JS with no bundler, so this also proves it parses
 * and that its factory only touches the module table it is given.
 */
async function loadClient() {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, exports: factory((specifier) => {
          if (specifier === 'react') return globalThis.__REACT_STUB__
          throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
        }) }
      },
    },
  }
  // The bundle calls `window.__ModuleLoader__.load(...)` at top level.
  new Function('window', 'document', source)(window, globalThis.__DOCUMENT_STUB__)
  return loaded
}

/** A minimal React stand-in: components are never rendered here, only built. */
function reactStub() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: undefined }),
  }
  return React
}

globalThis.__REACT_STUB__ = reactStub()
const head = { appendChild: () => {}, removeChild: () => {} }
globalThis.__DOCUMENT_STUB__ = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head,
}

const loaded = await loadClient()

// ---- module identity matches the package name ----
assert.equal(loaded.id, 'dsh-image-size-guard')

// ---- exports ----
assert.equal(typeof loaded.exports.apply, 'function')
assert.deepEqual(loaded.exports.inject, ['slots', 'locale'])

// ---- apply registers styles, locale, and one settings section ----
{
  const registrations = []
  const effects = []
  const localeRegistrations = []
  const injected = []
  const ctx = {
    effect(callback, label) {
      effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(ns, dicts) {
        localeRegistrations.push({ ns, locales: Object.keys(dicts) })
        return () => {}
      },
      bind(ns) {
        return (key) => `${ns}:${key}`
      },
    },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          return { ok: true, value: { providers: [], advertised: [] } }
        },
      },
    },
    slots: {
      inject(ownerKey, callback) {
        injected.push(ownerKey)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  loaded.exports.apply(ctx)

  // Styles are mounted through an effect, not at import time.
  assert.ok(effects.includes('dsh-image-size-guard: styles'))
  assert.ok(effects.includes('dsh-image-size-guard: locale'))

  // Both dictionaries are contributed, so the panel follows the active locale.
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].ns, 'settings.imageSizeGuard')
  assert.deepEqual(localeRegistrations[0].locales.sort(), ['en', 'zh'])

  // One settings page, plus the Turn-tail notice that makes an omission
  // visible in the conversation.
  assert.deepEqual(injected, ['settings.section', 'conversation.chat.turnTail'])
  assert.equal(registrations.length, 2)
  assert.equal(registrations[1].options.name, 'conversation.chat.turnTail')
  assert.equal(registrations[1].options.id, 'image-size-guard.offload')
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'image-size-guard')
  assert.equal(options.locale, 'settings.imageSizeGuard')
  assert.equal(typeof options.label(), 'string')
  assert.equal(options.label(), 'settings.imageSizeGuard:nav')
  assert.equal(typeof component, 'function')

  // The section receives its text and RPC caller through `inject`.
  const props = options.inject()
  assert.equal(typeof props.t, 'function')
  assert.equal(typeof props.rpcCall, 'function')
}

// ---- the label thunk re-reads the locale on every projection ----
{
  let current = 'en'
  const texts = { en: 'Image size guard', zh: '图片体积守卫' }
  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: (ns) => (key) => (key === 'nav' ? texts[current] : key),
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    slots: {
      inject: (_key, callback) => { callback(); return () => {} },
      register: (options) => {
        // Keep the Settings page: the Turn-tail notice registers separately.
        if (options.name === 'settings.section') ctx.options = options
        return () => {}
      },
    },
  }
  loaded.exports.apply(ctx)
  assert.equal(ctx.options.label(), 'Image size guard')
  current = 'zh'
  assert.equal(ctx.options.label(), '图片体积守卫', 'the shell never has to re-register on locale change')
}

console.log('all client tests passed')
