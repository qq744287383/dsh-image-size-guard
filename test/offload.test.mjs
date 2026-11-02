import assert from 'node:assert/strict'
import { imageOffloadProjection, offloadMessageImages, offloadOldestImages } from '../lib/offload.js'

const img = (name) => ({ type: 'image', attachment: { attachmentId: 'attachment-' + name, bytes: 10, width: 1, height: 1, mediaType: 'image/png', name } })

// ---- offloadMessageImages: pure marking ----
const message = { role: 'user', content: [{ type: 'text', text: 'a' }, img('x'), { type: 'text', text: 'b' }, img('y')] }
const marked = offloadMessageImages(message, [0, 1])
assert.equal(marked.content[1].offloaded, true)
assert.equal(marked.content[3].offloaded, true)
assert.equal(marked.content[0].text, 'a', 'non-image blocks are untouched')
assert.equal(message.content[1].offloaded, undefined, 'the input message is not mutated')

// Rejects an index that does not exist, and one already offloaded.
assert.throws(() => offloadMessageImages(message, [5]), /does not exist/)
assert.throws(() => offloadMessageImages(marked, [0]), /already offloaded/)

// ---- projection: validates the durable record ----
const events = [
  { type: 'system/message', seq: 0, data: {} },
  { type: 'user/message', seq: 1, data: message },
  { type: 'tool/result', seq: 2, data: { message: { role: 'tool', content: [img('t')] } } },
]
const context = { nodes: [0, 1, 2], events, baseSeq: 0, messages: new Map() }

const projected = imageOffloadProjection.project(
  { type: 'image/offload', seq: 3, data: { targets: [{ seq: 1, imageIndexes: [0] }] } },
  context,
)
assert.equal(projected.size, 1)
assert.equal(projected.get(1).content[1].offloaded, true)
assert.equal(projected.get(1).content[3].offloaded, undefined)

// Rejections: shape, membership, source type, ordering.
const rejects = [
  [{ targets: [] }, /nonempty targets array/],
  [{ targets: [{ seq: 1, imageIndexes: [] }] }, /nonempty imageIndexes/],
  [{ targets: [{ seq: 1, imageIndexes: [0], extra: 1 }] }, /must contain a seq and nonempty imageIndexes/],
  [{ targets: [{ seq: 0, imageIndexes: [0] }] }, /must be user\/message or tool\/result/],
  [{ targets: [{ seq: 99, imageIndexes: [0] }] }, /not a current surface node/],
  [{ targets: [{ seq: 1, imageIndexes: [1, 1] }] }, /strictly increasing/],
  [{ targets: [{ seq: 1, imageIndexes: [-1] }] }, /strictly increasing/],
  [{ targets: [{ seq: 1, imageIndexes: [0] }, { seq: 1, imageIndexes: [1] }] }, /duplicate target seq/],
  [{ targets: 'x' }, /nonempty targets array/],
]
for (const [data, pattern] of rejects) {
  assert.throws(() => imageOffloadProjection.project({ type: 'image/offload', seq: 3, data }, context), pattern)
}

// The event type is what the Session store keys projections by.
assert.equal(imageOffloadProjection.type, 'image/offload')

// ---- offloadOldestImages: durable selection ----
/** Minimal Session stand-in recording the appended event. */
function fakeSession(log) {
  return {
    appended: [],
    eventAt(seq) {
      return log[seq]
    },
    deriveEventMessage(event) {
      return event.type === 'user/message' ? event.data : event.data.message
    },
    append(type, data) {
      this.appended.push({ type, data })
      return { seq: log.length }
    },
  }
}

// Oldest first, assistant nodes excluded, only as many as asked.
const log = [
  { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [] } } },
  { type: 'user/message', seq: 1, data: { role: 'user', content: [img('a'), img('b')] } },
  { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [img('out')] } } },
  { type: 'user/message', seq: 3, data: { role: 'user', content: [img('c')] } },
]
const session = fakeSession(log)
assert.equal(offloadOldestImages(session, [0, 1, 2, 3], 2), true)
assert.deepEqual(session.appended[0], {
  type: 'image/offload',
  data: { targets: [{ seq: 1, imageIndexes: [0, 1] }] },
})

// Indexes count every image including already-omitted ones, so a later
// decision extends the earlier one instead of re-selecting it.
const extendedLog = [
  { type: 'user/message', seq: 0, data: { role: 'user', content: [img('a'), { ...img('b'), offloaded: true }, img('c')] } },
]
const extended = fakeSession(extendedLog)
assert.equal(offloadOldestImages(extended, [0], 2), true)
assert.deepEqual(extended.appended[0].data.targets, [{ seq: 0, imageIndexes: [0, 2] }], 'skips the omitted middle image')

// Nothing left to omit reports false and appends nothing.
const exhausted = fakeSession([{ type: 'user/message', seq: 0, data: { role: 'user', content: [{ ...img('a'), offloaded: true }] } }])
assert.equal(offloadOldestImages(exhausted, [0], 1), false)
assert.equal(exhausted.appended.length, 0)

console.log('all offload tests passed')
