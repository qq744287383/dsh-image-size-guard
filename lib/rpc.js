/**
 * The panel's Host half: a JSON RPC endpoint for provider limits.
 *
 * The endpoint is registered on `webServer` with the default `auth: 'required'`
 * policy, so the carrier applies its own Host/Origin checks and credential
 * verifiers and passes the admitted Peer in — the same admission the rest of
 * the API surface gets. Writes go through `configEditor.edit`, which validates
 * with this plugin's own `Config` and persists the profile patch layer the row
 * came from.
 *
 * @module image-size-guard/rpc
 */

import { PLUGIN_NAME, resolveConfig } from './config.js'

/** Endpoint path the browser client posts to. */
export const RPC_PATH = `/${PLUGIN_NAME}/limits`

/** Largest request body this endpoint accepts; these payloads are tiny. */
const MAX_BODY_BYTES = 64 * 1024

/** A successful envelope. */
function ok(value) {
  return { ok: true, value }
}

/** A failed envelope with a routable code. */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** Narrow a value to a plain object. */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Providers the LLM registry advertises, for the panel's suggestions.
 * @param ctx - the plugin context.
 * @returns provider route ids, or an empty list when the registry is absent.
 */
function advertisedProviders(ctx) {
  try {
    const llm = ctx.get('llm', false)
    return llm === undefined ? [] : llm.listProviders().map((provider) => provider.id)
  } catch {
    // A missing registry only costs the panel its suggestions.
    return []
  }
}

/**
 * Find the Loader entry this plugin was inserted under.
 * @param ctx - the plugin context.
 * @returns the entry, or undefined when the plugin runs outside the Loader.
 */
function findEntry(ctx) {
  const editor = ctx.get('configEditor', false)
  if (editor === undefined) return undefined
  return editor.entries().find((entry) => entry.options.id === PLUGIN_NAME)
}

/**
 * Persist a provider list, derived from the config that is actually on disk.
 *
 * `configEditor.edit` hands its callback the row's current persisted config, so
 * two saves in quick succession compose instead of racing: the second save sees
 * the first one's row even though this plugin instance has not restarted yet.
 *
 * The whole list is replaced rather than merged, because a removal has to be
 * expressed as an absent row.
 *
 * @param ctx - the plugin context.
 * @param change - derives the next list from the persisted one.
 * @returns the saved rows.
 * @throws {Error} when the profile row or the editor is unavailable.
 */
async function writeLimits(ctx, change) {
  const editor = ctx.get('configEditor', false)
  if (editor === undefined) throw new Error('This build cannot persist plugin settings (no config editor).')
  const entry = findEntry(ctx)
  if (entry === undefined) throw new Error(`No profile row is named "${PLUGIN_NAME}", so the limits cannot be saved.`)
  let saved
  await editor.edit(entry, (current) => {
    const persisted = resolveConfig(current)
    const config = resolveConfig({ providers: change(persisted.providers) })
    saved = config.providers
    return { providers: config.providers.map((limit) => ({ ...limit })) }
  })
  return saved ?? []
}

/**
 * Validate one incoming row against the panel's contract.
 * @param payload - the request payload.
 * @returns the normalized row.
 * @throws {Error} naming the offending field.
 */
function readLimitInput(payload) {
  const limit = asRecord(asRecord(payload)?.limit)
  if (limit === undefined) throw new Error('A limit object is required.')
  const provider = typeof limit.provider === 'string' ? limit.provider.trim() : ''
  if (provider.length === 0) throw new Error('A provider route name is required.')
  return resolveConfig({ providers: [{ ...limit, provider }] }).providers[0]
}

/**
 * Answer one panel request.
 * @param ctx - the plugin context.
 * @param readConfig - reads the guard's current resolved config.
 * @param payload - the decoded request body.
 * @returns the response envelope.
 */
async function handle(ctx, readConfig, payload) {
  const request = asRecord(payload)
  const endpoint = typeof request?.endpoint === 'string' ? request.endpoint : ''
  try {
    if (endpoint === 'limits.list') {
      const config = readConfig()
      return ok({
        providers: config.providers.map((limit) => ({ ...limit })),
        advertised: advertisedProviders(ctx),
      })
    }
    if (endpoint === 'limits.save') {
      const limit = readLimitInput(request.payload)
      const saved = await writeLimits(ctx, (current) =>
        current.some((row) => row.provider === limit.provider)
          ? current.map((row) => (row.provider === limit.provider ? limit : row))
          : [...current, limit],
      )
      return ok({ providers: saved.map((row) => ({ ...row })) })
    }
    if (endpoint === 'limits.remove') {
      const provider = typeof asRecord(request.payload)?.provider === 'string' ? asRecord(request.payload).provider.trim() : ''
      if (provider.length === 0) return fail('bad-request', 'A provider route name is required.')
      const saved = await writeLimits(ctx, (current) => current.filter((row) => row.provider !== provider))
      return ok({ providers: saved.map((row) => ({ ...row })) })
    }
    return fail('bad-request', `Unknown endpoint ${JSON.stringify(endpoint)}.`)
  } catch (error) {
    return fail('failed', error instanceof Error ? error.message : String(error))
  }
}

/** Read the whole request body, refusing anything over the cap. */
async function readBody(req) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Mount the panel endpoint.
 *
 * The carrier service is read at mount time, but it is not guaranteed to be
 * published yet: on a Harness restart the Loader may start this row before
 * `webServer` has activated. Reading it once and giving up left the route
 * unregistered for the life of the process — the Settings page rendered, but
 * every request it made answered 404. A missing service therefore defers the
 * mount through `ctx.inject`, and the route is registered exactly once.
 *
 * Admission is the carrier's own: a route registered without an `auth` policy
 * requires an authenticated Peer, and the handler receives that Peer. This
 * plugin used to call `connection.admit` itself, which stopped working when
 * that method began delegating to the separate `connection.authentication`
 * service — a call outside that service's inject scope throws, and a throw
 * inside a route surfaces as the carrier's bare 400.
 *
 * @param ctx - the plugin context.
 * @param readConfig - reads the guard's current resolved config.
 * @returns a disposer that also cancels a still-pending mount.
 */
export function mountRpc(ctx, readConfig) {
  const disposers = []
  const mount = (mountCtx) => {
    const server = mountCtx.get('webServer', false)
    if (server === undefined) return false
    disposers.push(server.register(createRoute(mountCtx, readConfig)))
    return true
  }

  // Mount now when the carrier is already here; otherwise wait for it.
  if (mount(ctx)) return () => disposeAll(disposers)
  if (typeof ctx.inject !== 'function') return () => disposeAll(disposers)
  ctx.inject(['webServer'], (injected) => {
    mount(injected)
  })

  return () => disposeAll(disposers)
}

/** Run every disposer, tolerating one that throws. */
function disposeAll(disposers) {
  for (const dispose of disposers.splice(0)) {
    try {
      const result = dispose()
      if (result !== undefined && typeof result.then === 'function') result.then(undefined, () => {})
    } catch {
      // A route already removed by its owning fiber needs no cleanup.
    }
  }
}

/**
 * Build the route the panel posts to.
 *
 * The registration carries no `auth` policy, which means the default: a live
 * Peer is required. The carrier therefore applies its Host/Origin checks and
 * its credential verifiers before this handler runs, and hands the admitted
 * Peer in — so the handler only has to answer.
 *
 * @param ctx - the plugin context.
 * @param readConfig - reads the guard's current resolved config.
 * @returns the route registration.
 */
function createRoute(ctx, readConfig) {
  /** Send one plain-text answer, if the response is still ours to write. */
  const respond = (res, status, text) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status)
    res.end(text)
  }
  return {
    kind: 'exact',
    path: RPC_PATH,
    auth: 'required',
    async handler(req, res, peer) {
      // A route owns its whole response, so an unexpected throw escapes into
      // the carrier's dispatcher, which can only answer a generic 400 with no
      // body — indistinguishable from a malformed request. Answer explicitly
      // instead, and keep the stack in the Host log.
      try {
        if (peer === undefined) {
          respond(res, 401, 'unauthorized')
          return
        }
        if (req.method !== 'POST') {
          respond(res, 405, 'method not allowed')
          return
        }
        const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          respond(res, 415, 'content type must be application/json')
          return
        }
        const body = await readBody(req)
        if (body === undefined) {
          respond(res, 413, '')
          req.destroy()
          return
        }
        let payload
        try {
          payload = JSON.parse(body || 'null')
        } catch {
          respond(res, 400, 'body is not JSON')
          return
        }
        const result = await handle(ctx, readConfig, payload)
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        ctx.logger?.warn?.('image-size-guard: settings request failed')
        ctx.logger?.warn?.(error)
        respond(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  }
}
