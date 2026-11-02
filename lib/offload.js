/**
 * Durable image omission: the pure replay definition of `image/offload`.
 *
 * The event and its projection are owned by `@deepseek-ai/dsh-compaction-image-offload`
 * in the shipped bundles. This module re-declares the projection so the plugin
 * stays self-contained in a profile where that bundle is not mounted — the
 * event type is a *known* Session event, and a Session log containing one
 * cannot be restored without an interpreter for it.
 *
 * @module image-size-guard/offload
 */

/** Whether a durable value is a JSON object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * Mark selected image occurrences of one message as permanently omitted.
 * @param message - the message projected before this decision.
 * @param indexes - nonempty, strictly increasing depth-first image indexes.
 * @returns a message with the same identity and the selected images marked.
 * @throws when a selected occurrence is missing or already offloaded.
 */
export function offloadMessageImages(message, indexes) {
  let imageIndex = 0
  let selected = 0
  const content = message.content.map((block) => {
    let projected = block
    if (block.type === 'image') {
      if (imageIndex === indexes[selected]) {
        if (block.offloaded === true) {
          throw new Error(`image/offload: image index ${imageIndex} is already offloaded`)
        }
        projected = { ...block, offloaded: true }
        selected += 1
      }
      imageIndex += 1
    }
    return projected
  })
  if (selected !== indexes.length) {
    throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  }
  return { ...message, content }
}

/** Atomic validation and reconstruction shared by live sessions and detached replay. */
export const imageOffloadProjection = {
  type: 'image/offload',
  project(event, context) {
    const data = event.data
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data.targets) || data.targets.length === 0) {
      throw new Error('image/offload: data must contain a nonempty targets array')
    }
    const messages = new Map()
    const nodes = new Set(context.nodes)
    for (const target of data.targets) {
      if (
        !isRecord(target) ||
        Object.keys(target).length !== 2 ||
        !isIndex(target.seq) ||
        !Array.isArray(target.imageIndexes) ||
        target.imageIndexes.length === 0
      ) {
        throw new Error('image/offload: each target must contain a seq and nonempty imageIndexes')
      }
      const seq = target.seq
      if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`)
      if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`)
      }
      let previous = -1
      for (const index of target.imageIndexes) {
        if (!isIndex(index) || index <= previous) {
          throw new Error('image/offload: imageIndexes must be strictly increasing non-negative safe integers')
        }
        previous = index
      }
      const message = context.messages.get(seq) ?? (source.type === 'user/message' ? source.data : source.data.message)
      messages.set(seq, offloadMessageImages(message, target.imageIndexes))
    }
    return messages
  },
}

/**
 * Record the oldest retained input images as permanently omitted.
 *
 * Indexes count every image in a message depth-first, including occurrences
 * already omitted, so a later decision can extend an earlier one. Assistant
 * nodes carry model output and are never selected.
 *
 * @param session - the Session whose next request applies the decision.
 * @param sourceEventSeqs - input message events in model-request order.
 * @param count - how many additional retained occurrences to omit.
 * @returns whether any occurrence remained to omit.
 */
export function offloadOldestImages(session, sourceEventSeqs, count) {
  const targets = []
  let remaining = count
  for (const seq of sourceEventSeqs) {
    if (remaining === 0) break
    const event = session.eventAt(seq)
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    const imageIndexes = []
    let imageIndex = 0
    for (const block of message.content) {
      if (remaining === 0) break
      if (block.type !== 'image') continue
      if (block.offloaded !== true) {
        imageIndexes.push(imageIndex)
        remaining -= 1
      }
      imageIndex += 1
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  if (targets.length === 0) return false
  session.append('image/offload', { targets })
  return true
}
