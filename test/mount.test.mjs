import assert from 'node:assert/strict'
import { mountRpc, RPC_PATH } from '../lib/rpc.js'
import { resolveConfig } from '../lib/config.js'

/**
 * Regression: the panel endpoint must survive a service that arrives late.
 *
 * Reported symptom: after restarting the Harness the Settings page rendered but
 * could not load its configuration — the page was registered (the client slot
 * was present) while `POST /image-size-guard/limits` answered 404. The cause was
 * `mountRpc` returning a no-op when `connection` had not published yet, with no
 * retry: the route was never registered for the life of the process.
 *
 * These tests pin the fix: a missing service defers the mount instead of
 * abandoning it, and a service that never appears still leaves the plugin inert
 * rather than throwing.
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

/** A connection stand-in. */
function fakeConnection() {
  return { admit: () => ({ peer: {} }) }
}

/**
 * A context whose services can be injected after the fact, and which runs
 * `inject` callbacks when a named service becomes available — the shape the
 * plugin relies on for a deferred mount.
 */
function fakeContext({ withWebServer = false, withConnection = false } = {}) {
  const pending = new Map()
  const ctx = {
    webServer: withWebServer ? fakeWebServer() : undefined,
    connection: withConnection ? fakeConnection() : undefined,
    get(name) {
      if (name === 'webServer') return ctx.webServer
      if (name === 'connection') return ctx.connection
      return undefined
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
    /** Publish a service, firing callbacks that were waiting only for it. */
    publish(name, value) {
      ctx[name] = value
      const waiting = pending.get(name) ?? []
      pending.delete(name)
      for (const entry of [...waiting]) {
        if (entry.names.every((required) => ctx.get(required) !== undefined)) {
          entry.callback(ctx)
        }
      }
    },
  }
  return ctx
}

const config = resolveConfig({ providers: [{ provider: 'agent2api', maxRequestBytes: 16 * 1024 * 1024 }] })

// ---- both services present: mount immediately ----
{
  const ctx = fakeContext({ withWebServer: true, withConnection: true })
  mountRpc(ctx, () => config)
  assert.ok(ctx.webServer.routes.has(RPC_PATH), 'the route is registered')
}

// ---- connection arrives after the plugin starts: still mounts ----
{
  const ctx = fakeContext({ withWebServer: true, withConnection: false })
  mountRpc(ctx, () => config)
  assert.equal(ctx.webServer.routes.size, 0, 'nothing is registered yet')

  // The Harness finishes booting and the Connection service publishes.
  ctx.publish('connection', fakeConnection())
  assert.ok(ctx.webServer.routes.has(RPC_PATH), 'the route mounts once the service appears')
}

// ---- webServer arrives after the plugin starts: still mounts ----
{
  const ctx = fakeContext({ withWebServer: false, withConnection: true })
  mountRpc(ctx, () => config)
  assert.equal(ctx.get('webServer'), undefined)

  const server = fakeWebServer()
  ctx.publish('webServer', server)
  assert.ok(server.routes.has(RPC_PATH), 'the route mounts once the carrier appears')
}

// ---- both arrive later: mounts exactly once ----
{
  const ctx = fakeContext({ withWebServer: false, withConnection: false })
  mountRpc(ctx, () => config)

  const server = fakeWebServer()
  ctx.publish('webServer', server)
  assert.equal(server.routes.size, 0, 'still waiting for connection')

  ctx.publish('connection', fakeConnection())
  assert.equal(server.routes.size, 1, 'mounted once, not twice')
  assert.ok(server.routes.has(RPC_PATH))
}

// ---- a service that never appears leaves the plugin inert, not throwing ----
{
  const ctx = fakeContext({ withWebServer: false, withConnection: false })
  const dispose = mountRpc(ctx, () => config)
  assert.equal(typeof dispose, 'function', 'a disposer is always returned')
  assert.equal(ctx.get('webServer'), undefined, 'nothing was registered, and nothing threw')
}

// ---- the deferred route still serves the panel's payload ----
{
  const ctx = fakeContext({ withWebServer: true, withConnection: false })
  mountRpc(ctx, () => config)
  ctx.publish('connection', fakeConnection())

  const route = ctx.webServer.routes.get(RPC_PATH)
  assert.equal(route.kind, 'exact')

  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ endpoint: 'limits.list' }))
    },
    destroy() {},
  }
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body ?? ''
    },
  }
  await route.handler(req, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.providers[0].provider, 'agent2api')
}

console.log('all late-service mount tests passed')
