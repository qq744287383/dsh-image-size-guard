import assert from 'node:assert/strict'
import {
  growthEstimate,
  planOmission,
  protectedStart,
  turnSizes,
} from '../lib/estimate.js'

/**
 * Batch policy: how many images one trigger retires.
 *
 * The point of the batch is cache behaviour, not bytes: every omission rewrites
 * an old message, so every omission invalidates a prompt cache from that point
 * on. Retiring one image per turn therefore costs a full re-prefill on every
 * turn. These tests pin the three properties that make the batch work:
 * it lands below a target sized from recent growth, it leaves the newest turns
 * alone, and it still never sends a request over the ceiling.
 */

const MiB = 1024 * 1024
const BUDGET = 10 * MiB - 256 * 1024
const ENCODED = Math.ceil(MiB / 3) * 4 // one 1 MiB image, base64

/** A history of `turns` turns, each a question plus one 1 MiB screenshot. */
function history(turns, text = 'q') {
  const messages = []
  const encoded = new Map()
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `${text}${index}` },
        { type: 'image', attachment: { attachmentId: `a${index}`, bytes: MiB, width: 8, height: 8, mediaType: 'image/png' } },
      ],
    })
    encoded.set(`${messages.length - 1}:1`, ENCODED)
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${index}` }] })
  }
  return { options: { messages, system: 'sys' }, encoded }
}

/** The shipped defaults, spelled out. */
const POLICY = { targetTurns: 5, minFillRatio: 0.4, growthWindow: 8, protectedTurns: 2 }

// ---- 1. turns are measured one per question, answer included ----
{
  const { options, encoded } = history(3)
  const sizes = turnSizes(options, encoded, 512)
  assert.equal(sizes.length, 3, 'one size per user message')
  assert.ok(sizes.every((size) => size > ENCODED), 'a turn carries its image and its text')
}

// ---- 2. growth is the upper quartile of the sampled window ----
{
  assert.equal(growthEstimate([], 8), 0)
  assert.equal(growthEstimate([10, 20, 30, 40], 8), 30, 'the fourth value is the upper quartile of four')
  assert.equal(growthEstimate([1, 2, 3, 100], 8), 3, 'one burst turn does not set the estimate')
  assert.equal(growthEstimate([1, 2, 3, 100], 2), 100, 'the window trims older turns')
  assert.equal(growthEstimate([5, 6], 8), 6, 'two turns resolve to the larger one')
}

// ---- 3. the protected tail starts at the Nth-newest question ----
{
  const { options } = history(4)
  assert.equal(protectedStart(options.messages, 0), options.messages.length, 'protecting nothing leaves everything deletable')
  assert.equal(protectedStart(options.messages, 2), 4, 'the last two turns start at message 4')
  assert.equal(protectedStart(options.messages, 99), 0, 'protecting more turns than exist protects everything')
}

// ---- 4. the batch lands on the target, not on the ceiling ----
{
  const { options, encoded } = history(8)
  const plan = planOmission(options, encoded, 512, BUDGET, POLICY)
  assert.ok(plan.before > BUDGET, 'the fixture really is over budget')
  assert.ok(plan.omitted.length > 1, `expected a batch rather than one image, got ${plan.omitted.length}`)
  assert.ok(plan.bytes <= plan.target, 'the batch reaches the target, not merely the ceiling')
  assert.equal(plan.protected, 2, 'the two newest turns keep their images')
  assert.ok(plan.omitted.length <= 6, 'the batch never reaches into the protected tail')
  assert.equal(plan.fits, true)
}

// ---- 5. the target is the low-water mark, computed from growth ----
{
  const { options, encoded } = history(8)
  const plan = planOmission(options, encoded, 512, BUDGET, POLICY)
  const expected = Math.min(BUDGET, Math.max(Math.round(BUDGET * 0.4), Math.round(BUDGET - 5 * plan.growth * 1.2)))
  assert.equal(plan.target, expected, 'target = max(40% floor, budget - 5 turns of growth x 1.2)')
  assert.equal(plan.growth, turnSizes(options, encoded, 512).at(-1), 'uniform turns make growth obvious')
}

// ---- 6. turning batching off restores one-image-at-a-time ----
{
  const { options, encoded } = history(8)
  const plan = planOmission(options, encoded, 512, BUDGET, { ...POLICY, targetTurns: 0 })
  assert.equal(plan.omitted.length, 1, 'the minimal policy retires exactly what the ceiling needs')
  assert.ok(plan.bytes <= BUDGET)
  assert.equal(plan.target, BUDGET)
}

// ---- 7. a tiny budget still reaches the tail when it has to ----
{
  const { options, encoded } = history(4)
  const tight = 2 * MiB
  const plan = planOmission(options, encoded, 512, tight, { ...POLICY, protectedTurns: 3 })
  assert.ok(plan.omitted.length > 1, 'the protected tail gives way rather than letting the request fail')
  assert.ok(plan.fits, 'the batch still lands under the hard ceiling')
}

// ---- 8. protection alone never leaves a sendable request unsent ----
{
  const { options, encoded } = history(3)
  const plan = planOmission(options, encoded, 512, BUDGET, { targetTurns: 5, minFillRatio: 0.4, protectedTurns: 99 })
  assert.equal(plan.unprotected, 0, 'every image is inside the protected window')
  assert.equal(plan.omitted.length, 0, 'a fitting request is left alone even when nothing is deletable')
  assert.equal(plan.bytes, plan.before)
  assert.equal(plan.fits, true)
}

// ---- 9. the floor caps how much a huge growth estimate may retire ----
{
  const { options, encoded } = history(8)
  const plan = planOmission(options, encoded, 512, BUDGET, { ...POLICY, targetTurns: 100 })
  assert.equal(plan.target, Math.round(BUDGET * 0.4), 'the 40% floor wins over an enormous growth target')
}

// ---- 10. the pre-omission size is reported for logging ----
{
  const { options, encoded } = history(8)
  const plan = planOmission(options, encoded, 512, BUDGET, POLICY)
  assert.ok(plan.before > plan.bytes, 'before is the size that triggered the batch')
  assert.ok(plan.before - plan.bytes >= plan.omitted.length * (ENCODED - 512) * 0.99)
}

// ---- 11. a request that fits is never trimmed down to the low-water mark ----
{
  // 11 x 1 MiB is ~14.7 MiB of images: under a 16 MiB ceiling, but well above
  // the 7.75 MiB low-water mark the batch would aim for. Batching must not
  // start work the ceiling never asked for.
  const { options, encoded } = history(11)
  const budget = 16 * MiB - 256 * 1024
  const plan = planOmission(options, encoded, 512, budget, POLICY)
  assert.ok(plan.before <= budget, 'the fixture fits')
  assert.equal(plan.omitted.length, 0, 'nothing is omitted below the ceiling')
  assert.equal(plan.bytes, plan.before)
  assert.equal(plan.fits, true)
}

console.log('all batch tests passed')
