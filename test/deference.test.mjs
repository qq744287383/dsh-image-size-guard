import assert from 'node:assert/strict'
import { apply, IMAGE_OFFLOAD_REQUIRED, REQUEST_TOO_LARGE } from '../lib/index.js'

/**
 * Two execution paths, chosen by whether the harness's own image-offload
 * executor is mounted.
 *
 * When it is, this plugin only *asks* — it yields `IMAGE_OFFLOAD_REQUIRED` and
 * the shipped executor writes the durable record. When it is not, the plugin
 * keeps its own self-contained implementation so a profile without that bundle
 * still works. These tests pin both, because the choice is silent at runtime.
 */

const MiB = 1024 * 1024

function userWithImage(bytes, name) {
  return {
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'attachment-' + name, bytes, width: 8, height: 8, mediaType: 'image/png', name } }],
  }
}

/** A context stand-in; `shippedProjection` decides which path the guard takes. */
function fakeContext({ session, shippedProjection }) {
  const listeners = new Map()
  const projections = []
  const logs = []
  if (shippedProjection !== undefined) projections.push(shippedProjection)
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
      if (name === 'llm') return { imageRequestTarget: () => ({ width: 8, height: 8, maxBytes: MiB }) }
      // Report each image's own stored size, so a 5 MiB history really is
      // over budget rather than being flattened to one MiB.
      if (name === 'attachments') return { readImageRequest: async (ref) => ({ bytes: ref.bytes }) }
      if (name === 'webServer') return { register: () => () => {} }
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

async function runStream(ctx, options) {
  const [listener] = ctx.listeners.get('llm/stream')
  const next = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const chunks = []
  for await (const chunk of listener(options, next)) chunks.push(chunk)
  return chunks
}

const baseOptions = (messages) => ({ provider: 'agent2api', model: 'm', messages, sessionId: 'session-test' })
const overBudget = () => [0, 1, 2, 3].map((i) => userWithImage(5 * MiB, 'big' + i))

// ---- path 1: the shipped executor is mounted, so we only ask ----
{
  const shipped = { type: 'image/offload', project() {} }
  const session = fakeSession(overBudget())
  const ctx = fakeContext({ session, shippedProjection: shipped })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })

  // We must not claim the projection when the shipped bundle already owns it.
  assert.equal(ctx.projections.length, 1, 'the shipped owner is left alone')
  assert.equal(ctx.projections[0], shipped)

  const chunks = await runStream(ctx, baseOptions(overBudget()))
  assert.equal(chunks.length, 1, 'only the terminal chunk is emitted')
  const failure = chunks[0].reason.failure
  assert.equal(failure.code, IMAGE_OFFLOAD_REQUIRED, 'the harness signal, not our own code')
  assert.ok(Number.isSafeInteger(failure.offloadImages) && failure.offloadImages > 0, 'a positive omission count')
  assert.ok(failure.offloadImages < 4, 'a partial omission, not the whole history')

  // We did NOT write the record ourselves: the shipped executor does that.
  assert.equal(session.appended.length, 0, 'the executor owns the durable write')

  // We do not answer the retry either; the executor returns the retry action.
  const [onError] = ctx.listeners.get('agent/request-error')
  const decision = await onError({ failure, signal: new AbortController().signal }, async () => 'downstream')
  assert.equal(decision, 'downstream', 'the retry decision belongs to the shipped executor')
}

// ---- path 2: no shipped executor, so we do the whole job ourselves ----
{
  const session = fakeSession(overBudget())
  const ctx = fakeContext({ session })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })

  // We contribute the projection the event needs to replay.
  assert.equal(ctx.projections.length, 1)
  assert.equal(ctx.projections[0].type, 'image/offload')

  const chunks = await runStream(ctx, baseOptions(overBudget()))
  const failure = chunks[0].reason.failure
  assert.equal(failure.code, REQUEST_TOO_LARGE, 'our own code when we own the omission')
  assert.equal(failure.offloadImages, undefined, 'the shipped field is not set on our code')
  assert.equal(session.appended.length, 1, 'we write the durable record')
  assert.equal(session.appended[0].type, 'image/offload')

  // And we answer our own retry.
  const [onError] = ctx.listeners.get('agent/request-error')
  assert.deepEqual(await onError({ failure, signal: new AbortController().signal }, async () => undefined), { kind: 'retry' })
}

// ---- both paths leave a fitting request alone ----
{
  for (const shippedProjection of [undefined, { type: 'image/offload', project() {} }]) {
    const messages = [userWithImage(1000, 'small')]
    const session = fakeSession(messages)
    const ctx = fakeContext({ session, shippedProjection })
    apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })
    const chunks = await runStream(ctx, baseOptions(messages))
    assert.equal(chunks.at(-1).reason.kind, 'stop', 'a fitting request reaches the provider')
    assert.equal(session.appended.length, 0)
  }
}

// ---- the compaction path answers only its own code ----
{
  const session = fakeSession(overBudget())
  const ctx = fakeContext({ session })
  apply(ctx, { providers: [{ provider: 'agent2api', maxRequestBytes: 16 * MiB }] })
  const [onSummaryError] = ctx.listeners.get('compaction/summary-error')
  assert.equal(await onSummaryError({ error: { code: REQUEST_TOO_LARGE }, signal: undefined }, async () => false), true)
  assert.equal(await onSummaryError({ error: { code: IMAGE_OFFLOAD_REQUIRED }, signal: undefined }, async () => false), false,
    'the shipped executor owns its own code')
}

console.log('all executor-deference tests passed')
