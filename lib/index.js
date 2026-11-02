/**
 * Keep model requests under a gateway's request-body ceiling by replacing the
 * oldest history images with placeholder text.
 *
 * ## Why this seam
 *
 * `llm/stream` is the one place where the exact `GenerateOptions` a provider
 * would receive is visible before it leaves the process. A waterfall listener
 * cannot rewrite those options for the downstream listener, so this plugin does
 * not try: when a request is over budget it records a durable `image/offload`
 * decision and ends the attempt with a terminal failure. The agent loop's
 * `agent/request-error` waterfall then retries, and the loop rebuilds the
 * request from the session surface — which now carries the omission. Each
 * attempt therefore re-measures a genuinely smaller body.
 *
 * Omitting the *minimum* number of images is the wrong objective once a
 * provider caches the prompt prefix. Every omission rewrites an old message, so
 * every omission invalidates the cache from that point on; deleting one image
 * per turn means paying a full re-prefill on every turn. The estimator therefore
 * retires a batch that lands the body on a low-water mark sized from recent
 * per-turn growth, buying several cache-warm turns per invalidation, and leaves
 * the most recent turns' images alone unless nothing else fits.
 *
 * @module image-size-guard
 */

import { Config, PLUGIN_NAME, activeLimits, budgetOf, policyOf, resolveConfig } from './config.js'
import { base64Length, planOmission, retainedImageOccurrences } from './estimate.js'
import { imageOffloadProjection, offloadOldestImages } from './offload.js'
import { mountRpc } from './rpc.js'

export const name = PLUGIN_NAME
// `webServer` is required by the Connection RPC channel this plugin mounts for
// its panel: `connection.rpc.handle` registers the route on the caller's own
// context, so the caller must be able to resolve that service.
export const inject = ['sessions', 'webServer']
export { Config }

/** Failure code this plugin raises for a request it declined to send, when it
 *  performs the omission itself. */
export const REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE'

/**
 * The harness's own image-omission signal, `IMAGE_OFFLOAD_REQUIRED`.
 *
 * Declared as a literal rather than imported: this bundle installs into a
 * profile where `@deepseek-ai/dsh-llm` is not resolvable from the plugin's own
 * module graph. The value is a stable wire contract — the shipped executor
 * compares `failure.code` against exactly this string — so duplicating it is
 * safer than depending on a package this plugin cannot import.
 */
export const IMAGE_OFFLOAD_REQUIRED = 'IMAGE_OFFLOAD_REQUIRED'

/**
 * Build the base64-size lookup for one request's retained images.
 *
 * The adapter re-encodes every image to a request version bounded by the
 * route's pixel and byte policy before base64-expanding it. The stored
 * normalized size is not that number, so an estimate built on it could
 * under-count and leave the request over the ceiling. The adapter caches these
 * versions by variant id, so asking here costs one cache lookup that the
 * adapter's own pass immediately reuses.
 *
 * @param ctx - the plugin context.
 * @param options - the request being measured.
 * @returns base64 length per `messageIndex:blockIndex`, falling back to the
 *   stored size when a version cannot be resolved.
 */
async function encodedSizes(ctx, options) {
  const sizes = new Map()
  const byAttachment = new Map()
  const attachments = ctx.get('attachments', false)
  for (const occurrence of retainedImageOccurrences(options.messages)) {
    const ref = occurrence.block.attachment
    const key = String(ref.attachmentId)
    let encoded = byAttachment.get(key)
    if (encoded === undefined) {
      let bytes = ref.bytes
      if (attachments !== undefined) {
        try {
          const llm = ctx.get('llm', false)
          const target = llm.imageRequestTarget(options.provider, options.model, ref)
          const version = await attachments.readImageRequest(ref, target, options.signal)
          bytes = version.bytes
        } catch {
          // A missing encoder route or a rejected image is the adapter's
          // failure to report; the stored size still bounds the body.
        }
      }
      encoded = base64Length(bytes)
      byAttachment.set(key, encoded)
    }
    sizes.set(`${occurrence.messageIndex}:${occurrence.blockIndex}`, encoded)
  }
  return sizes
}

/**
 * Build the terminal chunk that asks the harness to omit the oldest images.
 *
 * The chunk is a normal `finish` with an error reason, not a thrown error: the
 * agent loop treats a thrown stream error as this attempt's death and re-throws
 * it, so only a finish chunk reaches the `agent/request-error` waterfall where
 * the executor listens. The adapter reaches the same outcome by turning a
 * thrown `IMAGE_OFFLOAD_REQUIRED` into exactly this chunk.
 *
 * @param count - how many additional retained occurrences must be omitted.
 * @param budget - the byte budget the request exceeded.
 * @returns the finish chunk carrying the omission request.
 */
function imageOffloadRequired(count, budget) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: `request exceeded the ${budget}-byte budget; ${count} more oldest occurrence(s) must be offloaded`,
        code: IMAGE_OFFLOAD_REQUIRED,
        offloadImages: count,
      },
    },
  }
}

/**
 * Mount the request guard.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's `config`, already validated by `Config`.
 */
export function apply(ctx, rawConfig) {
  let config = resolveConfig(rawConfig)

  // The shipped image-offload bundle owns this event type when it is mounted;
  // a second registration throws, so contribute only when it is absent.
  const shippedExecutorOwnsProjection = ctx.sessions.messageProjections.some(
    (item) => item.type === imageOffloadProjection.type,
  )
  if (!shippedExecutorOwnsProjection) {
    ctx.sessions.registerMessageProjection(imageOffloadProjection)
  }

  // The panel edits the row this instance was started from; a save reconciles
  // the Loader, which restarts this plugin with the new config.
  ctx.effect(() => mountRpc(ctx, () => config), 'image-size-guard: settings RPC')

  ctx.on('llm/stream', (options, next) => {
    const limit = activeLimits(config).get(options.provider)
    if (limit === undefined || options.sessionId === undefined) return next()
    const budget = budgetOf(limit)
    return (async function* () {
      const session = ctx.sessions.get(options.sessionId)
      if (session === undefined) {
        yield* next()
        return
      }
      let plan
      try {
        plan = planOmission(
          options,
          await encodedSizes(ctx, options),
          limit.placeholderBytes,
          budget,
          policyOf(limit),
        )
      } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: request-size check failed; sending the request unchanged`)
        ctx.logger.warn(error)
        yield* next()
        return
      }
      if (plan.omitted.length === 0) {
        if (!plan.fits) {
          ctx.logger.warn(
            `${PLUGIN_NAME}: ${options.provider}/${options.model} request is ~${plan.bytes} bytes with no images left to omit; sending it unchanged`,
          )
        }
        yield* next()
        return
      }

      // Hand the decision to the harness's own executor when it is mounted: it
      // owns the `image/offload` event, so letting it write the record keeps one
      // implementation of the projection. The count is still this plugin's
      // batch, because the executor retires exactly the oldest N.
      if (shippedExecutorOwnsProjection) {
        ctx.logger.info(
          `${PLUGIN_NAME}: ${options.provider}/${options.model} request is ~${plan.before} bytes (target ${plan.target}, growth ~${plan.growth}/turn); asking the image-offload executor to omit ${plan.omitted.length} oldest image(s)`,
        )
        yield imageOffloadRequired(plan.omitted.length, budget)
        return
      }

      // The omission is durable, so the retry rebuilds a strictly smaller body.
      // End this attempt without contacting the provider.
      let recorded = false
      try {
        recorded = offloadOldestImages(session, session.surface.nodes, plan.omitted.length)
      } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: could not record the image omission; sending the request unchanged`)
        ctx.logger.warn(error)
      }
      if (!recorded) {
        yield* next()
        return
      }
      ctx.logger.info(
        `${PLUGIN_NAME}: ${options.provider}/${options.model} request was ~${plan.before} bytes (target ${plan.target}, growth ~${plan.growth}/turn); omitted ${plan.omitted.length} oldest image(s) and retrying`,
      )
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `request exceeded the ${budget}-byte budget; the ${plan.omitted.length} oldest history image(s) were omitted and the request will be retried`,
            code: REQUEST_TOO_LARGE,
          },
        },
      }
    })()
  })

  // Retry after a declined request: the surface now carries the omission, so
  // the loop's rebuild is strictly smaller. Nothing else raises this code.
  ctx.on('agent/request-error', ({ failure, signal }, next) => {
    if (failure.code !== REQUEST_TOO_LARGE || signal.aborted) return next()
    return Promise.resolve({ kind: 'retry' })
  })

  // A compaction summary carries the same history through the same seam; its
  // recovery re-prepares the input instead of rebuilding a turn.
  ctx.on('compaction/summary-error', ({ error, signal }, next) => {
    if (error?.code !== REQUEST_TOO_LARGE || signal?.aborted === true) return next()
    return true
  })
}
