/**
 * Request-size estimation over the exact message list a model request carries.
 *
 * The estimate mirrors what an OpenAI-compatible adapter puts on the wire: one
 * JSON body in which every retained image block becomes a base64 data URL. It
 * models the body rather than reproducing it byte-for-byte — provider
 * envelopes, HTTP headers, and adapter-specific fields are invisible at the
 * `llm/stream` seam — so callers keep a reserve below the gateway ceiling
 * instead of treating the estimate as exact.
 */

/**
 * Base64 length of raw bytes, including padding.
 * @param bytes - raw encoded byte count.
 * @returns the number of base64 characters those bytes expand to.
 */
export function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4
}

/** Whether a content block is an image occurrence. */
function isImage(block) {
  return block !== null && typeof block === 'object' && block.type === 'image'
}

/** Whether a block already carries the durable omission mark. */
function isOffloaded(block) {
  return block.offloaded === true
}

/** Whether a message carries model output instead of request input. */
function isAssistant(message) {
  return message.role === 'assistant'
}

/**
 * List the image occurrences a request still sends as image data, oldest first.
 *
 * Assistant messages carry model output rather than request input, so they are
 * excluded — the same rule the durable omission projection follows.
 *
 * @param messages - the request's message list.
 * @returns one entry per occurrence, naming its message and block position.
 */
export function retainedImageOccurrences(messages) {
  const occurrences = []
  for (const [messageIndex, message] of messages.entries()) {
    if (isAssistant(message)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (isImage(block) && !isOffloaded(block)) {
        occurrences.push({ messageIndex, blockIndex, block })
      }
    }
  }
  return occurrences
}

/**
 * Measure the JSON body one request would become.
 *
 * Text, tool declarations, and the system prompt are measured by serializing a
 * shadow of the request in which each retained image is an empty string and
 * each omitted image is placeholder-sized text; image payloads are then added
 * from `encodedBytes`. Cost is therefore linear in the request's text rather
 * than in its image data.
 *
 * @param options - `system`, `messages`, and `tools` from the request.
 * @param encodedBytes - base64 length of one occurrence, keyed by
 *   `messageIndex:blockIndex` as reported by {@link retainedImageOccurrences}.
 * @param placeholderBytes - bytes assumed for one placeholder text block.
 * @returns the estimated request body size in bytes.
 */
export function measureRequest(options, encodedBytes, placeholderBytes) {
  const shadow = {
    ...(options.system === undefined ? {} : { system: options.system }),
    messages: options.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block) => {
        if (!isImage(block)) return block
        return isOffloaded(block)
          ? { type: 'text', text: 'x'.repeat(placeholderBytes) }
          : { type: 'image', data: '' }
      }),
    })),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  }
  let bytes = Buffer.byteLength(JSON.stringify(shadow), 'utf8')
  for (const occurrence of retainedImageOccurrences(options.messages)) {
    bytes += encodedBytes.get(`${occurrence.messageIndex}:${occurrence.blockIndex}`) ?? 0
  }
  return bytes
}

/**
 * Measure one message the way {@link measureRequest} measures the whole body.
 * @param message - the message.
 * @param encodedBytes - base64 length of one occurrence.
 * @param messageIndex - its position, the key prefix for `encodedBytes`.
 * @param placeholderBytes - bytes assumed for one placeholder text block.
 * @returns the message's contribution to the body in bytes.
 */
function messageBytes(message, encodedBytes, messageIndex, placeholderBytes) {
  const shadow = {
    role: message.role,
    content: message.content.map((block) => {
      if (!isImage(block)) return block
      return isOffloaded(block)
        ? { type: 'text', text: 'x'.repeat(placeholderBytes) }
        : { type: 'image', data: '' }
    }),
  }
  let bytes = Buffer.byteLength(JSON.stringify(shadow), 'utf8')
  for (const [blockIndex, block] of message.content.entries()) {
    if (isImage(block) && !isOffloaded(block)) {
      bytes += encodedBytes.get(`${messageIndex}:${blockIndex}`) ?? 0
    }
  }
  return bytes
}

/**
 * Split a request into turns and measure each one.
 *
 * A turn starts at every user message and carries everything up to the next
 * one, which is exactly the unit a conversation adds per exchange. The sizes
 * feed the growth estimate that decides how far below the ceiling one omission
 * should land.
 *
 * @param options - `messages` from the request.
 * @param encodedBytes - base64 length of one occurrence.
 * @param placeholderBytes - bytes assumed for one placeholder text block.
 * @returns one byte size per turn, oldest first.
 */
export function turnSizes(options, encodedBytes, placeholderBytes) {
  const sizes = []
  let current = 0
  let started = false
  for (const [messageIndex, message] of options.messages.entries()) {
    if (message.role === 'user' && started) {
      sizes.push(current)
      current = 0
    }
    current += messageBytes(message, encodedBytes, messageIndex, placeholderBytes)
    started = true
  }
  if (started) sizes.push(current)
  return sizes
}

/**
 * Median size of the most recent turns.
 *
 * The median rather than the mean, so one turn that pastes five screenshots
 * The upper quartile rather than the mean, so one turn that pastes five
 * screenshots does not inflate the estimate and delete half the history — but
 * still above the median, because a session whose turns alternate between text
 * and screenshots must size the batch for the screenshot turns: under-
 * estimating costs an immediate second omission, which is the very cost this
 * batching exists to avoid. The caller applies a safety factor on top.
 *
 * @param sizes - per-turn byte sizes, oldest first.
 * @param window - how many recent turns to sample.
 * @returns the upper-quartile turn size, or zero when there is nothing to sample.
 */
export function growthEstimate(sizes, window) {
  if (sizes.length === 0) return 0
  const recent = sizes.slice(-Math.max(1, window)).sort((left, right) => left - right)
  const index = Math.min(recent.length - 1, Math.ceil(recent.length * 0.75) - 1)
  return recent[index]
}

/**
 * Index of the first message that belongs to the last `turns` turns.
 *
 * Images at or after this index are protected: they are the ones the model is
 * most likely to still need, so a batch retires them only when nothing older
 * would bring the request under the ceiling.
 *
 * @param messages - the request's message list.
 * @param turns - how many recent turns to protect; zero protects nothing.
 * @returns the first protected message index; zero when every turn is protected.
 */
export function protectedStart(messages, turns) {
  if (turns <= 0) return messages.length
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue
    seen += 1
    if (seen === turns) return index
  }
  return 0
}

/**
 * Choose which retained images to omit, and how many.
 *
 * Two regimes share one loop. Below the budget nothing happens. Once over it,
 * the batch retires oldest first until the body reaches a *target* below the
 * ceiling, so the next few turns do not trigger again — every omission
 * invalidates a prefix cache from the first changed image onward, so one large
 * omission that buys several quiet turns costs far less than one image per
 * turn. Images inside the protected tail are skipped while an unprotected one
 * remains, and are sacrificed only when the request would otherwise go out
 * over the ceiling.
 *
 * @param options - the request being measured.
 * @param encodedBytes - base64 length of one occurrence, keyed by
 *   `messageIndex:blockIndex`.
 * @param placeholderBytes - bytes assumed for one placeholder text block.
 * @param budget - the largest body size allowed to leave the process.
 * @param policy - batching shape: `targetTurns` (0 keeps the minimal policy),
 *   `minFillRatio`, `growthWindow`, `protectedTurns`, and `safety`.
 * @returns the occurrences to omit, the resulting size, whether it fits, and
 *   the target/growth/protection figures the decision used.
 */
export function planOmission(options, encodedBytes, placeholderBytes, budget, policy = {}) {
  const targetTurns = policy.targetTurns ?? 0
  const growth =
    targetTurns > 0
      ? growthEstimate(turnSizes(options, encodedBytes, placeholderBytes), policy.growthWindow ?? 8)
      : 0
  const floor = Math.round(budget * (policy.minFillRatio ?? 0.4))
  const target = Math.min(
    budget,
    Math.max(
      0,
      targetTurns > 0
        ? Math.max(floor, Math.round(budget - targetTurns * growth * (policy.safety ?? 1.2)))
        : budget,
    ),
  )

  const occurrences = retainedImageOccurrences(options.messages)
  const firstProtected = protectedStart(options.messages, policy.protectedTurns ?? 0)
  const unprotected = occurrences.filter((occurrence) => occurrence.messageIndex < firstProtected).length
  let bytes = measureRequest(options, encodedBytes, placeholderBytes)
  const before = bytes
  const omitted = []

  /** Retire one occurrence and keep the running estimate in step. */
  const omit = (occurrence) => {
    bytes -= encodedBytes.get(`${occurrence.messageIndex}:${occurrence.blockIndex}`) ?? 0
    bytes += placeholderBytes
    omitted.push(occurrence)
  }

  // A request that fits is never trimmed just because it sits above the
  // low-water mark; the batch only starts once the ceiling is crossed.
  if (before > budget) {
    // Fill down to the target, but never reach into the protected tail for it.
    for (const occurrence of occurrences) {
      if (bytes <= target || omitted.length >= unprotected) break
      omit(occurrence)
    }
    // Still over the hard ceiling: the tail has to give, but only enough to send.
    if (bytes > budget) {
      for (const occurrence of occurrences.slice(omitted.length)) {
        if (bytes <= budget) break
        omit(occurrence)
      }
    }
  }

  return {
    omitted,
    bytes,
    before,
    fits: bytes <= budget,
    target,
    growth,
    protected: occurrences.length - unprotected,
    unprotected,
  }
}
