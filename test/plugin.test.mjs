import assert from 'node:assert/strict'
import { apply, REQUEST_TOO_LARGE } from '../lib/index.js'

const MiB = 1024 * 1024

/** A message whose one image claims `bytes` raw. */
function userWithImage(bytes, name) {
  return {
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'attachment-' + name, bytes, width: 8, height: 8, mediaType: 'image/png', name } }],
  }
}

/**
 * A context stand-in that records listeners and exposes the two services the
 * plugin touches: a Session store and an LLM/attachments pair.
 */
function fakeContext({ session, imageBytes = () => undefined }) {
  const listeners = new Map()
  const projections = []
  const logs = []
  return {
    listeners,
    projections,
    logs,
    sessions: {
      messageProjections: projections,
      registerMessageProjection(projection) {
        projections.push(projection)
      },
      get() {
        return session
      },
    },
    get(name) {
      if (name === 'llm') {
        return {
          imageRequestTarget: () => ({ width: 8, height: 8, maxBytes: MiB }),
        }
      }
      if (name === 'attachments') {
        return {
          async readImageRequest(ref) {
            const exact = imageBytes(ref)
            if (exact === undefined) throw new Error('no version')
            return { bytes: exact }
          },
        }
      }
      return undefined
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

/** Run the `llm/stream` waterfall for one request and collect the chunks. */
async function runStream(ctx, options) {
  const [listener] = ctx.listeners.get('llm/stream')
  const next = () => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'sent-to-provider' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const chunks = []
  for await (const chunk of listener(options, next)) chunks.push(chunk)
  return chunks
}

/** A session stand-in that records appended events. */
function fakeSession(messages) {
  const log = messages.map((data, index) => ({ type: 'user/message', seq: index, data }))
  return {
    appended: [],
    surface: { nodes: log.map((event) => event.seq) },
    eventAt(seq) {
      return log[seq]
    },
    deriveEventMessage(event) {
      return event.data
    },
    append(type, data) {
      this.appended.push({ type, data })
      return { seq: log.length }
    },
  }
}

const baseOptions = (messages) => ({
  provider: 'agent2api',
  model: 'deepseek-v4.1-flash',
  messages,
  sessionId: 'session-test',
})

// ---- 1. Under budget: the request passes through untouched ----
{
  const messages = [userWithImage(1000, 'small')]
  const session = fakeSession(messages)
  const ctx = fakeContext({ session })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })
  const chunks = await runStream(ctx, baseOptions(messages))
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'a fitting request reaches the provider')
  assert.equal(session.appended.length, 0, 'nothing is omitted')
}

// ---- 2. Over budget: oldest images omitted, attempt ends without dispatch ----
{
  // Four 5 MiB images: base64 expands each to ~6.67 MiB, so ~26.7 MiB total.
  const messages = [0, 1, 2, 3].map((i) => userWithImage(5 * MiB, 'big' + i))
  const session = fakeSession(messages)
  const ctx = fakeContext({ session })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })
  const chunks = await runStream(ctx, baseOptions(messages))

  assert.equal(chunks.length, 1, 'only the terminal failure is emitted')
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, REQUEST_TOO_LARGE)
  assert.equal(session.appended.length, 1, 'exactly one durable decision')
  assert.equal(session.appended[0].type, 'image/offload')

  const targets = session.appended[0].data.targets
  const omitted = targets.reduce((sum, target) => sum + target.imageIndexes.length, 0)
  assert.ok(omitted >= 1 && omitted < 4, `expected a partial omission, got ${omitted}`)

  // The selection must be the oldest occurrences, in order.
  const selected = []
  for (const target of targets) for (const index of target.imageIndexes) selected.push(target.seq)
  assert.deepEqual(selected, [...selected].sort((a, b) => a - b), 'oldest first')
}

// ---- 3. A provider this plugin does not guard is untouched ----
{
  const session = fakeSession([userWithImage(50 * MiB, 'huge')])
  const ctx = fakeContext({ session })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })
  const chunks = await runStream(ctx, { ...baseOptions([userWithImage(50 * MiB, 'huge')]), provider: 'openscg' })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(session.appended.length, 0)
}

// ---- 4. The retry path: REQUEST_TOO_LARGE retries, other codes do not ----
{
  const session = fakeSession([userWithImage(50 * MiB, 'huge')])
  const ctx = fakeContext({ session })
  apply(ctx, {})
  const [onError] = ctx.listeners.get('agent/request-error')
  const signal = new AbortController().signal

  const retried = await onError({ failure: { code: REQUEST_TOO_LARGE, message: 'x' }, signal }, async () => undefined)
  assert.deepEqual(retried, { kind: 'retry' })

  const passed = await onError({ failure: { code: 'RATE_LIMIT', message: 'x' }, signal }, async () => 'downstream')
  assert.equal(passed, 'downstream', 'other failures reach the next listener')

  const aborted = await onError({ failure: { code: REQUEST_TOO_LARGE, message: 'x' }, signal: AbortSignal.abort() }, async () => 'downstream')
  assert.equal(aborted, 'downstream', 'a cancelled turn is not retried')
}

// ---- 5. Compaction summaries take the same recovery path ----
{
  const session = fakeSession([userWithImage(50 * MiB, 'huge')])
  const ctx = fakeContext({ session })
  apply(ctx, {})
  const [onSummaryError] = ctx.listeners.get('compaction/summary-error')
  assert.equal(await onSummaryError({ error: { code: REQUEST_TOO_LARGE }, signal: undefined }, async () => false), true)
  assert.equal(await onSummaryError({ error: { code: 'OTHER' }, signal: undefined }, async () => false), false)
}

// ---- 6. The projection is contributed exactly once ----
{
  const session = fakeSession([])
  const ctx = fakeContext({ session })
  apply(ctx, {})
  assert.equal(ctx.projections.length, 1)
  assert.equal(ctx.projections[0].type, 'image/offload')

  // A second instance must not double-register, which the store would reject.
  const second = fakeContext({ session })
  second.projections.push(...ctx.projections)
  apply(second, {})
  assert.equal(second.projections.length, 1, 'the shipped bundle keeps ownership when present')
}

// ---- 7. No images left: the request is sent rather than blocking the turn ----
{
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }]
  const session = fakeSession(messages)
  const ctx = fakeContext({ session })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 1024, reserveBytes: 512 }] })
  const chunks = await runStream(ctx, baseOptions(messages))
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'an oversized text-only request still goes out')
  assert.equal(session.appended.length, 0, 'there was nothing to omit')
  assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && message.includes('no images left to omit')))
}

// ---- 8. An estimate failure never blocks the request ----
{
  const messages = [userWithImage(50 * MiB, 'huge')]
  const session = fakeSession(messages)
  const ctx = fakeContext({ session })
  // Corrupt the request so measurement throws mid-flight.
  const broken = { ...baseOptions(messages), messages: [{ role: 'user', content: [null] }] }
  apply(ctx, {})
  const chunks = await runStream(ctx, broken)
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'a measurement failure falls through to the provider')
}

// ---- 9. One trigger retires a batch, not a single image ----
{
  // Eight turns, one 1 MiB screenshot each, under a 10 MiB ceiling: the old
  // policy retired one image and hit the ceiling again on the next turn, so
  // every turn paid for a full cache rebuild.
  const messages = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => userWithImage(MiB, 'turn' + i))
  const session = fakeSession(messages)
  const ctx = fakeContext({ session })
  apply(ctx, {
    providers: [
      {
        provider: 'agent2api',
        maxRequestBytes: 10 * MiB,
        reserveBytes: 256 * 1024,
        targetTurns: 5,
        minFillPercent: 40,
        protectedTurns: 2,
        growthWindow: 8,
      },
    ],
  })
  const chunks = await runStream(ctx, baseOptions(messages))
  assert.equal(chunks.length, 1, 'the attempt still ends without contacting the provider')

  const targets = session.appended[0].data.targets
  const omitted = targets.reduce((sum, target) => sum + target.imageIndexes.length, 0)
  assert.ok(omitted > 1, `expected a batch, got ${omitted}`)
  assert.ok(omitted <= 6, `the newest two turns are protected, got ${omitted} of 8`)

  const info = ctx.logs.filter(([level]) => level === 'info').map(([, message]) => message).join('\n')
  assert.ok(info.includes('target '), 'the log names the low-water mark the batch aimed for')
  assert.ok(info.includes('growth ~'), 'the log names the growth estimate it used')
}

console.log('all plugin wiring tests passed')
