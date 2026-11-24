import assert from 'node:assert/strict'
import { mountRpc, RPC_PATH } from '../lib/rpc.js'
import { resolveConfig } from '../lib/config.js'
import { readFile } from 'node:fs/promises'

/**
 * Mount behaviour of the panel endpoint.
 *
 * Two regressions are pinned here, both reported from a running Harness.
 *
 * 1. A late `webServer` used to leave the route unregistered for the life of
 *    the process: the Settings page rendered (its client slot was present)
 *    while `POST /image-size-guard/limits` answered 404.
 * 2. Admission used to run through `connection.admit` from this plugin's own
 *    context. When that method began delegating to the separate
 *    `connection.authentication` service, the call threw outside that service's
 *    inject scope, and a throw inside a route surfaces as the carrier's bare
 *    400 — the panel then showed "HTTP 400" with no body.
 *
 * The route therefore declares `auth: 'required'` and lets the carrier admit
 * the request, which is also what the current contract documents.
 */

/** A web server stand-in that records the routes registered on it. */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/**
 * A context whose services can be injected after the fact, and which runs
 * `inject` callbacks when a named service becomes available.
 */
function fakeContext({ withWebServer = false } = {}) {
  const pending = new Map()
  const ctx = {
    webServer: withWebServer ? fakeWebServer() : undefined,
    get(name) {
      return name === 'webServer' ? ctx.webServer : undefined
    },
    inject(names, callback) {
      const missing = names.filter((name) => ctx.get(name) === undefined)
      if (missing.length === 0) {
        callback(ctx)
        return () => {}
      }
      const entry = { names, callback }
      for (const name of missing) {
        const list = pending.get(name) ?? []
        list.push(entry)
        pending.set(name, list)
      }
      return () => {
        for (const list of pending.values()) {
          const index = list.indexOf(entry)
          if (index >= 0) list.splice(index, 1)
        }
      }
    },
    publish(name, value) {
      ctx[name] = value
      const waiting = pending.get(name) ?? []
      pending.delete(name)
      for (const entry of [...waiting]) {
        if (entry.names.every((required) => ctx.get(required) !== undefined)) entry.callback(ctx)
      }
    },
  }
  return ctx
}

const config = resolveConfig({ providers: [{ provider: 'agent2api', maxRequestBytes: 16 * 1024 * 1024 }] })

/** A request stand-in carrying one JSON body. */
function request(body, overrides = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
    destroy() {},
    ...overrides,
  }
}

/** A response stand-in recording status and body. */
function response() {
  return {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.status = status
      this.headersSent = true
    },
    end(body) {
      this.body = body ?? ''
    },
    destroy() {},
  }
}

// ---- the carrier is present: mount immediately ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => config)
  assert.ok(ctx.webServer.routes.has(RPC_PATH), 'the route is registered')
}

// ---- the carrier arrives after the plugin starts: still mounts ----
{
  const ctx = fakeContext({ withWebServer: false })
  mountRpc(ctx, () => config)
  assert.equal(ctx.get('webServer'), undefined, 'nothing to register on yet')

  const server = fakeWebServer()
  ctx.publish('webServer', server)
  assert.ok(server.routes.has(RPC_PATH), 'the route mounts once the carrier appears')
  assert.equal(server.routes.size, 1, 'mounted once, not twice')
}

// ---- a carrier that never appears leaves the plugin inert, not throwing ----
{
  const ctx = fakeContext({ withWebServer: false })
  const dispose = mountRpc(ctx, () => config)
  assert.equal(typeof dispose, 'function', 'a disposer is always returned')
  assert.equal(ctx.get('webServer'), undefined, 'nothing was registered, and nothing threw')
}

// ---- the route asks the carrier to admit the request ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => config)
  const route = ctx.webServer.routes.get(RPC_PATH)
  assert.equal(route.kind, 'exact')
  assert.equal(route.auth, 'required', 'the carrier enforces authentication, not this plugin')
}

// ---- the route serves the panel payload to an admitted Peer ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => config)
  const route = ctx.webServer.routes.get(RPC_PATH)

  const res = response()
  await route.handler(request({ endpoint: 'limits.list' }), res, { principal: 'owner' })
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.providers[0].provider, 'agent2api')
}

// ---- a request the carrier did not admit is refused, not served ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => config)
  const route = ctx.webServer.routes.get(RPC_PATH)

  const res = response()
  await route.handler(request({ endpoint: 'limits.list' }), res, undefined)
  assert.equal(res.status, 401)
}

// ---- a throw inside the handler answers 500, not the carrier's bare 400 ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => config)
  const route = ctx.webServer.routes.get(RPC_PATH)

  // A body stream that fails mid-read: readBody propagates, which is outside
  // the handlers that answer envelopes.
  const broken = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      throw new Error('boom')
    },
    destroy() {},
  }
  const res = response()
  await route.handler(broken, res, { principal: 'owner' })
  assert.equal(res.status, 500, 'the panel can tell an internal fault from a malformed request')
  assert.match(res.body, /boom/)
}

// ---- a failing readConfig is a business failure, reported in the envelope ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => {
    throw new Error('corrupt row')
  })
  const route = ctx.webServer.routes.get(RPC_PATH)

  const res = response()
  await route.handler(request({ endpoint: 'limits.list' }), res, { principal: 'owner' })
  assert.equal(res.status, 200, 'the endpoint answers, and the panel reads the failure from the envelope')
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.match(payload.error.message, /corrupt row/)
}

// ---- a non-JSON body is still the caller's fault, and says so ----
{
  const ctx = fakeContext({ withWebServer: true })
  mountRpc(ctx, () => config)
  const route = ctx.webServer.routes.get(RPC_PATH)

  const raw = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('not json at all')
    },
    destroy() {},
  }
  const res = response()
  await route.handler(raw, res, { principal: 'owner' })
  assert.equal(res.status, 400)
  assert.equal(res.body, 'body is not JSON')
}

// ---- the plugin no longer reaches for a connection service of its own ----
{
  const source = await readFile(new URL('../lib/rpc.js', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/connection\.admit/.test(code), false, 'admission belongs to the carrier')
  assert.equal(/ctx\.get\('connection'/.test(code), false, 'the plugin needs no connection service')
}

console.log('all late-service mount tests passed')