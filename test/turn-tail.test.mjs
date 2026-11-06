import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * The Turn-tail notice that makes an image omission visible.
 *
 * Before it existed the omission was invisible in the UI: the Session log keeps
 * the image, the Chat view renders it normally, and only the model received a
 * path. The notice is derived from the durable `image/offload` event in the
 * Session event window the Conversation view already holds, so these tests pin
 * both the registration and the Turn membership rules.
 */

// ---- React shim -----------------------------------------------------------
globalThis.__REACT_STUB__ = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false),
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
globalThis.__DOCUMENT_STUB__ = { getElementById: () => null, createElement: () => ({ id: 'x', textContent: '' }), head: { appendChild: () => {} } }

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

/** Flatten an element tree into readable text. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join('')
}

/** Install the bundle against a context whose session window we control. */
function mount({ window: eventWindow, sessions = true } = {}) {
  const registrations = []
  const dicts = {}
  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (_ns, value) => {
        Object.assign(dicts, value)
        return () => {}
      },
      bind: () => (key, vars) => {
        const raw = dicts.zh[key] ?? key
        return vars === undefined ? raw : Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), raw)
      },
    },
    get: (name) => {
      if (name !== 'sessions') return undefined
      if (!sessions) return undefined
      return { binding: () => ({ eventSource: { getSnapshot: () => eventWindow, subscribe: () => () => {} } }) }
    },
    slots: {
      inject: (_key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { registrations, dicts, turnTail: registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail') }
}

/** One durable omission decision. */
function offloadEvent(seq, counts) {
  return {
    type: 'event',
    event: {
      type: 'image/offload',
      seq,
      time: 1_700_000_000_000 + seq,
      data: { targets: counts.map((images, index) => ({ seq: 100 + index, imageIndexes: Array.from({ length: images }, (_, i) => i) })) },
    },
  }
}

/** The stamp the row should print for one timestamp, mirroring the component. */
function stampOfFixture(time) {
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A closed Turn spanning `start..end`. */
const turn = (start, end) => ({ turn: 1, start: { seq: start }, end: { seq: end }, status: 'closed', steps: [] })

/** Render the registered notice for one Turn. */
function render({ window, turn: location, seq, sessions }) {
  const mounted = mount({ window, sessions })
  const props = mounted.turnTail.options.inject('session-1')
  return { element: mounted.turnTail.component({ ...props, turn: location, seq }), mounted }
}

// ---- 1. it registers into the Turn tail as an additive entry ----
{
  const { turnTail } = mount({ window: { entries: [] } })
  assert.ok(turnTail, 'the notice registers into conversation.chat.turnTail')
  assert.equal(turnTail.options.name, 'conversation.chat.turnTail')
  assert.equal(turnTail.options.id, 'image-size-guard.offload', 'it uses its own cell id')
  assert.ok(typeof turnTail.options.order === 'number', 'it can be ordered among the other entries')
}

// ---- 2. a Turn that retired nothing renders nothing ----
{
  const { element } = render({ window: { entries: [] }, turn: turn(10, 20), seq: 20 })
  assert.equal(element, null, 'no omission, no row')
}

// ---- 3. a Turn that retired images says how many, and when ----
{
  const now = Date.now()
  const window = { entries: [{ ...offloadEvent(15, [2, 1]), event: { ...offloadEvent(15, [2, 1]).event, time: now } }] }
  const { element } = render({ window, turn: turn(10, 20), seq: 20 })
  assert.ok(element, 'the row appears')
  assert.ok(textOf(element).includes('3'), 'the count sums every retired occurrence')
  assert.ok(textOf(element).includes('{count}') === false, 'the placeholder is substituted')
  // The time is part of the row, not only its tooltip.
  const stamp = element.children.find((child) => String(child.props.className ?? '').includes('dsg-turnoff-time'))
  assert.ok(stamp, 'the row carries a visible time')
  assert.equal(textOf(stamp), stampOfFixture(now), 'today is shown as HH:MM')
  assert.ok(/^\d{2}:\d{2}$/.test(textOf(stamp)))
}

// ---- 3b. an older Turn shows its date, so history cannot look fresh ----
{
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000
  const window = { entries: [{ ...offloadEvent(15, [1]), event: { ...offloadEvent(15, [1]).event, time: threeDaysAgo } }] }
  const { element } = render({ window, turn: turn(10, 20), seq: 20 })
  const stamp = element.children.find((child) => String(child.props.className ?? '').includes('dsg-turnoff-time'))
  assert.ok(/^\d{1,2}-\d{1,2} \d{2}:\d{2}$/.test(textOf(stamp)), `expected a dated stamp, got ${textOf(stamp)}`)
}

// ---- 3c. an unusable time degrades to no stamp rather than a wrong one ----
{
  const window = { entries: [{ ...offloadEvent(15, [1]), event: { ...offloadEvent(15, [1]).event, time: undefined } }] }
  const { element } = render({ window, turn: turn(10, 20), seq: 20 })
  assert.equal(
    element.children.some((child) => String(child.props.className ?? '').includes('dsg-turnoff-time')),
    false,
    'no time, no stamp',
  )
}

// ---- 3d. the row says which plugin produced it ----
{
  const window = { entries: [offloadEvent(15, [2])] }
  const { element, mounted } = render({ window, turn: turn(10, 20), seq: 20 })
  const source = element.children.find((child) => String(child.props.className ?? '').includes('dsg-turnoff-source'))
  assert.ok(source, 'the row carries an attribution segment')
  assert.ok(textOf(source).includes(mounted.dicts.zh.nav), 'the attribution names the plugin')
  assert.equal(textOf(source).includes('{plugin}'), false, 'the plugin placeholder is substituted')
}

// ---- 4. membership is the Turn's own range, not the whole window ----
{
  const window = { entries: [offloadEvent(5, [4]), offloadEvent(15, [1]), offloadEvent(99, [7])] }
  const { element } = render({ window, turn: turn(10, 20), seq: 20 })
  assert.ok(textOf(element).includes('1'), 'only the event inside the Turn counts')
  assert.equal(textOf(element).includes('4'), false, 'an older Turn is ignored')
  assert.equal(textOf(element).includes('7'), false, 'a later Turn is ignored')
}

// ---- 5. an open Turn falls back to the closing sequence it was given ----
{
  const window = { entries: [offloadEvent(18, [2])] }
  const { element } = render({ window, turn: { turn: 1, start: { seq: 10 }, end: undefined, status: 'open', steps: [] }, seq: 20 })
  assert.ok(element, 'a Turn with no recorded end still resolves its own events')
  assert.ok(textOf(element).includes('2'))
}

// ---- 6. several decisions in one Turn add up ----
{
  const window = { entries: [offloadEvent(12, [1]), offloadEvent(18, [2, 2])] }
  const { element } = render({ window, turn: turn(10, 20), seq: 20 })
  assert.ok(textOf(element).includes('5'), 'repeated triggers in one Turn are summed')
}

// ---- 7. the window is described, not required ----
{
  const { element } = render({ window: { entries: [] }, turn: turn(10, 20), seq: 20, sessions: false })
  assert.equal(element, null, 'a profile without the sessions service degrades to no row')
}

// ---- 8. a malformed window never breaks the Turn ----
{
  const { element } = render({ window: undefined, turn: turn(10, 20), seq: 20 })
  assert.equal(element, null)
}

// ---- 9. both locales name the row ----
{
  const { dicts } = mount({ window: { entries: [] } })
  for (const key of ['offloadNote', 'offloadMessages', 'offloadWhen', 'offloadHint', 'attribution']) {
    assert.ok(dicts.zh[key] && dicts.en[key], `${key} exists in both locales`)
  }
  assert.ok(dicts.zh.offloadNote.includes('{count}'), 'the count placeholder is in the dictionary')
  assert.ok(dicts.en.offloadNote.includes('{count}'))
  assert.ok(dicts.zh.attribution.includes('{plugin}'), 'the attribution names the plugin through a placeholder')
  assert.ok(dicts.en.attribution.includes('{plugin}'))
}

console.log('all turn-tail tests passed')
