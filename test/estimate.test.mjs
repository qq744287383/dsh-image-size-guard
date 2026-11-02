import assert from 'node:assert/strict'
import { base64Length, retainedImageOccurrences, measureRequest, planOmission } from '../lib/estimate.js'

const MiB = 1024 * 1024
const img = (bytes, name) => ({
  type: 'image',
  attachment: { attachmentId: 'attachment-' + name, mediaType: 'image/png', bytes, width: 100, height: 100, name },
})
const user = (content) => ({ role: 'user', content })
const asst = (content) => ({ role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } })

// 1. base64 sizing
assert.equal(base64Length(3), 4)
assert.equal(base64Length(4), 8)

// 2. ordering: oldest first, assistant excluded, offloaded excluded
const msgs = [
  user([{ type: 'text', text: 'hi' }, img(1000, 'a')]),
  asst([img(9999, 'out')]),
  user([img(2000, 'b'), { type: 'text', text: 'mid' }]),
  {
    role: 'tool',
    content: [
      { type: 'image', attachment: { attachmentId: 'attachment-c', bytes: 3000, width: 1, height: 1, mediaType: 'image/png' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'attachment-d', bytes: 5, width: 1, height: 1, mediaType: 'image/png' } },
    ],
    source: { kind: 'tool', callId: 'c1' },
    toolCallId: 'c1',
  },
]
const occ = retainedImageOccurrences(msgs)
assert.deepEqual(occ.map((o) => [o.messageIndex, o.blockIndex]), [[0, 1], [2, 0], [3, 0]])

// 3. measure: text-only baseline + image payload
const sizes = new Map([['0:1', 4000], ['2:0', 8000], ['3:0', 12000]])
const total = measureRequest({ messages: msgs }, sizes, 512)
const noImages = measureRequest(
  { messages: msgs.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== 'image') })) },
  new Map(),
  512,
)
assert.ok(total > noImages, 'images must add to the measurement')

// 4. plan: no omission when it fits
const fits = planOmission({ messages: msgs }, sizes, 512, total + 1)
assert.equal(fits.omitted.length, 0)
assert.equal(fits.fits, true)

// 5. plan: one omission is enough when the budget allows exactly that
const oneOmission = total - 4000 + 512
const plan = planOmission({ messages: msgs }, sizes, 512, oneOmission)
assert.deepEqual(plan.omitted.map((o) => o.messageIndex), [0], 'oldest image only')
assert.equal(plan.fits, true)
assert.equal(plan.bytes, oneOmission)

// 5b. one byte short: the loop continues to the next oldest image
const oneShort = planOmission({ messages: msgs }, sizes, 512, oneOmission - 1)
assert.deepEqual(oneShort.omitted.map((o) => o.messageIndex), [0, 2])

// 6. every image omitted still leaves placeholder text in the body
const plan2 = planOmission({ messages: msgs }, sizes, 512, noImages + 3 * 512 + 4096)
assert.deepEqual(plan2.omitted.map((o) => [o.messageIndex, o.blockIndex]), [[0, 1], [2, 0], [3, 0]])
assert.equal(plan2.fits, true)
assert.ok(plan2.bytes > noImages, 'placeholders replace the images rather than vanishing')

// 7. realistic: 20 x 1MiB images under a 16MiB ceiling
const many = Array.from({ length: 20 }, (_, i) => user([img(MiB, 'i' + i)]))
const manySizes = new Map(many.map((_, i) => [`${i}:0`, base64Length(MiB)]))
const big = planOmission({ messages: many }, manySizes, 512, 16 * MiB)
assert.ok(big.fits, 'must fit after omission')
assert.ok(big.omitted.length > 0 && big.omitted.length < 20, `expected partial omission, got ${big.omitted.length}`)
assert.ok(big.bytes <= 16 * MiB)
console.log('all estimate tests passed; omitted', big.omitted.length, 'of 20; final ~', big.bytes, 'bytes')
