import assert from 'node:assert/strict'
import {
  resolveConfig,
  Config,
  budgetOf,
  policyOf,
  activeLimits,
  defaultLimit,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MIN_FILL_PERCENT,
  DEFAULT_PROTECTED_TURNS,
  DEFAULT_TARGET_TURNS,
  DEFAULT_GROWTH_WINDOW,
} from '../lib/config.js'

const MiB = 1024 * 1024

// ---- defaults ----
const defaults = resolveConfig(undefined)
assert.equal(defaults.providers.length, 1)
assert.equal(defaults.providers[0].provider, 'agent2api')
assert.equal(defaults.providers[0].maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES)
assert.equal(defaults.providers[0].enabled, true)
assert.equal(defaults.providers[0].targetTurns, DEFAULT_TARGET_TURNS)
assert.equal(defaults.providers[0].minFillPercent, DEFAULT_MIN_FILL_PERCENT)
assert.equal(defaults.providers[0].protectedTurns, DEFAULT_PROTECTED_TURNS)
assert.equal(defaults.providers[0].growthWindow, DEFAULT_GROWTH_WINDOW)
assert.ok(Object.isFrozen(defaults))
assert.ok(Object.isFrozen(defaults.providers[0]))
assert.deepEqual(resolveConfig({}), defaults)

// ---- explicit rows ----
const custom = resolveConfig({
  providers: [
    { provider: 'agent2api', maxRequestBytes: 16 * MiB, reserveBytes: 256 * 1024, placeholderBytes: 512, enabled: true },
    { provider: 'openscg', maxRequestBytes: 8 * MiB, reserveBytes: 1024, placeholderBytes: 256, enabled: false },
  ],
})
assert.equal(custom.providers.length, 2)
assert.equal(custom.providers[1].provider, 'openscg')
assert.equal(custom.providers[1].enabled, false)

// ---- per-provider budget ----
assert.equal(budgetOf(custom.providers[0]), 16 * MiB - 256 * 1024)
assert.equal(budgetOf(custom.providers[1]), 8 * MiB - 1024)

// ---- only enabled rows are active ----
const active = activeLimits(custom)
assert.equal(active.size, 1)
assert.ok(active.has('agent2api'))
assert.equal(active.has('openscg'), false, 'a disabled row guards nothing')

// ---- defaults fill omitted fields ----
const partial = resolveConfig({ providers: [{ provider: 'p1' }] })
assert.deepEqual(partial.providers[0], defaultLimit('p1'))

// ---- trimming ----
assert.equal(resolveConfig({ providers: [{ provider: '  spaced  ' }] }).providers[0].provider, 'spaced')

// ---- rejections, each naming the offending field ----
const rejects = [
  [{ providers: 'nope' }, /providers must be an array of limit rows/],
  [{ providers: [null] }, /providers\[0\] must be an object/],
  [{ providers: [{}] }, /providers\[0\]\.provider must be a non-empty provider route name/],
  [{ providers: [{ provider: '' }] }, /provider must be a non-empty/],
  [{ providers: [{ provider: 'a', maxRequestBytes: 0 }] }, /maxRequestBytes must be a positive safe integer/],
  [{ providers: [{ provider: 'a', maxRequestBytes: 1.5 }] }, /maxRequestBytes must be a positive safe integer/],
  [{ providers: [{ provider: 'a', reserveBytes: -1 }] }, /reserveBytes must be a positive safe integer/],
  [{ providers: [{ provider: 'a', placeholderBytes: 'x' }] }, /placeholderBytes must be a positive safe integer/],
  [{ providers: [{ provider: 'a', enabled: 'yes' }] }, /enabled must be a boolean/],
  [{ providers: [{ provider: 'a', maxRequestBytes: 100, reserveBytes: 100 }] }, /reserveBytes must be smaller than maxRequestBytes/],
  [{ providers: [{ provider: 'a', maxRequestBytes: 100, reserveBytes: 10, placeholderBytes: 100 }] }, /placeholderBytes must be smaller than maxRequestBytes/],
  [{ providers: [{ provider: 'a', targetTurns: -1 }] }, /targetTurns must be a non-negative safe integer/],
  [{ providers: [{ provider: 'a', targetTurns: 1.5 }] }, /targetTurns must be a non-negative safe integer/],
  [{ providers: [{ provider: 'a', protectedTurns: -2 }] }, /protectedTurns must be a non-negative safe integer/],
  [{ providers: [{ provider: 'a', growthWindow: 0 }] }, /growthWindow must be a positive safe integer/],
  [{ providers: [{ provider: 'a', minFillPercent: 0 }] }, /minFillPercent must be an integer between 1 and 100/],
  [{ providers: [{ provider: 'a', minFillPercent: 101 }] }, /minFillPercent must be an integer between 1 and 100/],
  [{ providers: [{ provider: 'a', minFillPercent: 40.5 }] }, /minFillPercent must be an integer between 1 and 100/],
  [{ providers: [{ provider: 'a' }, { provider: 'a' }] }, /names "a" more than once/],
]

// ---- batching knobs are optional and translate into an estimator policy ----
const batching = resolveConfig({
  providers: [{ provider: 'a', targetTurns: 0, minFillPercent: 55, protectedTurns: 0, growthWindow: 3 }],
})
assert.equal(batching.providers[0].targetTurns, 0, 'zero is a valid batch size: it disables batching')
assert.deepEqual(policyOf(batching.providers[0]), {
  targetTurns: 0,
  minFillRatio: 0.55,
  growthWindow: 3,
  protectedTurns: 0,
})
assert.deepEqual(policyOf(defaultLimit('x')), {
  targetTurns: DEFAULT_TARGET_TURNS,
  minFillRatio: DEFAULT_MIN_FILL_PERCENT / 100,
  growthWindow: DEFAULT_GROWTH_WINDOW,
  protectedTurns: DEFAULT_PROTECTED_TURNS,
})
for (const [input, pattern] of rejects) assert.throws(() => resolveConfig(input), pattern)

// ---- the Standard Schema surface reports instead of throwing ----
const good = Config['~standard'].validate({})
assert.ok(good.value !== undefined && good.issues === undefined)
const bad = Config['~standard'].validate({ providers: [{ provider: '' }] })
assert.equal(bad.value, undefined)
assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0)

// An absent config is accepted, which is what an empty `config:` produces.
assert.equal(Config['~standard'].validate(null).value.providers[0].provider, 'agent2api')

console.log('all config tests passed')
