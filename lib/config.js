/**
 * Plugin configuration: one request-size limit per guarded provider.
 *
 * The panel in Settings edits exactly this value, so the shape here is the
 * shape the panel presents: an ordered list of provider rows, each carrying
 * its own ceiling. Keeping the limits in the Loader row means the guard and the
 * panel read one source, and a save reaches the guard through the ordinary
 * plugin reload instead of a second store that could drift.
 *
 * The schema is a plain Standard Schema validator, so the bundle installs into
 * any profile without depending on the Harness's own packages.
 */

/** Plugin identity, reused by the manifest and the Loader row. */
export const PLUGIN_NAME = 'image-size-guard'

/** 16 MiB: the gateway's request-body ceiling this plugin keeps requests under. */
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024

/**
 * Headroom kept free below `maxRequestBytes`. The estimate is a deliberate
 * over-count, but the provider envelope, HTTP headers, and any adapter-specific
 * field this plugin does not model are not visible at the `llm/stream` seam, so
 * a request is only admitted once it fits with room to spare.
 */
export const DEFAULT_RESERVE_BYTES = 256 * 1024

/**
 * Bytes one placeholder text block is assumed to occupy. The adapter renders
 * the real placeholder itself; this is only the estimate's stand-in, chosen
 * larger than the adapter's actual text so the estimate stays conservative.
 */
export const DEFAULT_PLACEHOLDER_BYTES = 512

/**
 * Turns of growth one omission should buy.
 *
 * Omitting the minimum brings the next turn straight back to the ceiling, and
 * every omission rewrites an early image — which invalidates a prefix cache
 * from that point on. One larger batch that leaves several quiet turns costs
 * far less than one image per turn. Zero keeps the minimal policy.
 */
export const DEFAULT_TARGET_TURNS = 5

/** Share of the budget a batch never drops below, as a percentage. */
export const DEFAULT_MIN_FILL_PERCENT = 40

/**
 * Recent turns whose images a batch leaves alone. These are the images the
 * current question is most likely about, so they are retired only when the
 * request cannot otherwise be sent.
 */
export const DEFAULT_PROTECTED_TURNS = 2

/** Turns sampled to estimate per-turn growth. */
export const DEFAULT_GROWTH_WINDOW = 8

/** The provider guarded when the row names none. */
export const DEFAULT_PROVIDER = 'agent2api'

/** A positive safe integer, the only numeric shape a limit accepts. */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** A non-negative safe integer, for counts where zero disables a feature. */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A non-empty provider route name. */
function isProviderName(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The limit a provider starts from when the panel adds it.
 * @param provider - provider route id.
 * @returns a complete limit with the shipped defaults.
 */
export function defaultLimit(provider) {
  return {
    provider,
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
    reserveBytes: DEFAULT_RESERVE_BYTES,
    placeholderBytes: DEFAULT_PLACEHOLDER_BYTES,
    targetTurns: DEFAULT_TARGET_TURNS,
    minFillPercent: DEFAULT_MIN_FILL_PERCENT,
    protectedTurns: DEFAULT_PROTECTED_TURNS,
    growthWindow: DEFAULT_GROWTH_WINDOW,
    enabled: true,
  }
}

/**
 * Normalize one candidate limit row, collecting field-level problems.
 * @param raw - the candidate row.
 * @param index - its position, for the message.
 * @param issues - collector for validation problems.
 * @returns the normalized row, or undefined when it was rejected.
 */
function normalizeLimit(raw, index, issues) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ message: `providers[${index}] must be an object` })
    return undefined
  }
  const provider = raw.provider
  if (!isProviderName(provider)) {
    issues.push({ message: `providers[${index}].provider must be a non-empty provider route name` })
    return undefined
  }
  const limit = { provider: provider.trim(), enabled: raw.enabled !== false }
  for (const key of ['maxRequestBytes', 'reserveBytes', 'placeholderBytes']) {
    const value = raw[key]
    if (value === undefined) {
      limit[key] = defaultLimit(limit.provider)[key]
      continue
    }
    if (!isPositiveInteger(value)) {
      issues.push({ message: `providers[${index}].${key} must be a positive safe integer number of bytes` })
      return undefined
    }
    limit[key] = value
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    issues.push({ message: `providers[${index}].enabled must be a boolean` })
    return undefined
  }
  const counts = {
    targetTurns: { allowZero: true, default: DEFAULT_TARGET_TURNS },
    protectedTurns: { allowZero: true, default: DEFAULT_PROTECTED_TURNS },
    growthWindow: { allowZero: false, default: DEFAULT_GROWTH_WINDOW },
  }
  for (const [key, rule] of Object.entries(counts)) {
    const value = raw[key]
    if (value === undefined) {
      limit[key] = rule.default
      continue
    }
    const valid = rule.allowZero ? isNonNegativeInteger(value) : isPositiveInteger(value)
    if (!valid) {
      const shape = rule.allowZero ? 'a non-negative' : 'a positive'
      issues.push({ message: `providers[${index}].${key} must be ${shape} safe integer count of turns` })
      return undefined
    }
    limit[key] = value
  }
  if (raw.minFillPercent === undefined) {
    limit.minFillPercent = DEFAULT_MIN_FILL_PERCENT
  } else if (
    !Number.isSafeInteger(raw.minFillPercent) ||
    raw.minFillPercent < 1 ||
    raw.minFillPercent > 100
  ) {
    issues.push({ message: `providers[${index}].minFillPercent must be an integer between 1 and 100` })
    return undefined
  } else {
    limit.minFillPercent = raw.minFillPercent
  }
  if (limit.reserveBytes >= limit.maxRequestBytes) {
    issues.push({ message: `providers[${index}].reserveBytes must be smaller than maxRequestBytes` })
    return undefined
  }
  if (limit.placeholderBytes >= limit.maxRequestBytes) {
    issues.push({ message: `providers[${index}].placeholderBytes must be smaller than maxRequestBytes` })
    return undefined
  }
  return limit
}

/**
 * Validate one raw config object and apply defaults.
 * @param raw - the row's `config`, possibly empty or absent.
 * @returns the complete config.
 * @throws {Error} listing every rejected field.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const issues = []

  let providers
  if (source.providers === undefined) {
    providers = [defaultLimit(DEFAULT_PROVIDER)]
  } else if (!Array.isArray(source.providers)) {
    issues.push({ message: 'providers must be an array of limit rows' })
    providers = []
  } else {
    providers = source.providers
      .map((entry, index) => normalizeLimit(entry, index, issues))
      .filter((entry) => entry !== undefined)
    const seen = new Set()
    for (const entry of providers) {
      if (seen.has(entry.provider)) issues.push({ message: `providers names "${entry.provider}" more than once` })
      seen.add(entry.provider)
    }
  }

  if (issues.length > 0) {
    const error = new Error(`${PLUGIN_NAME}: ${issues.map((issue) => issue.message).join('; ')}`)
    error.issues = issues
    throw error
  }

  return Object.freeze({
    providers: Object.freeze(providers.map((entry) => Object.freeze(entry))),
  })
}

/**
 * The budget one limit allows.
 * @param limit - one provider's limit.
 * @returns `maxRequestBytes - reserveBytes`.
 */
export function budgetOf(limit) {
  return limit.maxRequestBytes - limit.reserveBytes
}

/**
 * The batching policy one limit asks the estimator for.
 * @param limit - one provider's limit.
 * @returns the policy `planOmission` consumes.
 */
export function policyOf(limit) {
  return {
    targetTurns: limit.targetTurns,
    minFillRatio: limit.minFillPercent / 100,
    growthWindow: limit.growthWindow,
    protectedTurns: limit.protectedTurns,
  }
}

/**
 * The limits the guard acts on.
 * @param config - a resolved config.
 * @returns enabled limits keyed by provider route.
 */
export function activeLimits(config) {
  const active = new Map()
  for (const limit of config.providers) {
    if (limit.enabled) active.set(limit.provider, limit)
  }
  return active
}

/** Standard Schema surface the Loader validates the row's `config` with. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: PLUGIN_NAME,
    validate(value) {
      try {
        return { value: resolveConfig(value) }
      } catch (error) {
        return { issues: error.issues ?? [{ message: error.message }] }
      }
    },
  },
}
