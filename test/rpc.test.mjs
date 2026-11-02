import assert from 'node:assert/strict'
import { mountRpc, RPC_PATH } from '../lib/rpc.js'
import { resolveConfig } from '../lib/config.js'

const MiB = 1024 * 1024

/**
 * A context stand-in exposing the optional services the endpoint reads, plus a
 * web server that captures the route it registers.
 */
function fakeContext({ config, entries = [{ options: { id: 'image-size-guard' } }], admitted = true } = {}) {
  const written = []
  const ctx = {
    written,
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            ctx.route = route
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        return {
          admit: () => (admitted ? { peer: {} } : { rejection: 401 }),
        }
      }
      if (name === 'llm') {
        return { listProviders: () => [{ id: 'agent2api', name: 'agent2api' }, { id: 'openscg', name: 'openscg' }] }
      }
      if (name === 'configEditor') {
        return {
          entries: () => entries,
          async edit(entry, change) {
            // The real editor hands the row's persisted config to the callback.
            const persisted = ctx.persisted ?? {}
            const next = change(persisted, {})
            ctx.persisted = next
            written.push({ entryId: entry.options.id, next })
          },
        }
      }
      return undefined
    },
  }
  ctx.config = config ?? resolveConfig(undefined)
  return ctx
}

/** A request stand-in: an async iterable body plus the headers the route reads. */
function fakeRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  }
}

/** A response stand-in capturing status, headers, and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      if (headers) this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

/** Drive the registered route with one request. */
async function call(ctx, body, options) {
  const res = fakeResponse()
  await ctx.route.handler(fakeRequest(body, options), res)
  let parsed
  try {
    parsed = res.body === '' ? undefined : JSON.parse(res.body)
  } catch {
    parsed = res.body
  }
  return { status: res.status, body: parsed }
}

// ---- route identity ----
assert.equal(RPC_PATH, '/image-size-guard/limits')

// ---- list returns rows plus advertised providers ----
{
  const ctx = fakeContext()
  mountRpc(ctx, () => ctx.config)
  assert.equal(ctx.route.kind, 'exact')
  assert.equal(ctx.route.path, RPC_PATH)
  const result = await call(ctx, { endpoint: 'limits.list' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.value.providers.length, 1)
  assert.equal(result.body.value.providers[0].provider, 'agent2api')
  assert.deepEqual(result.body.value.advertised, ['agent2api', 'openscg'])
}

// ---- save replaces an existing row ----
{
  const ctx = fakeContext()
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, {
    endpoint: 'limits.save',
    payload: { limit: { provider: 'agent2api', maxRequestBytes: 8 * MiB, reserveBytes: 1024, placeholderBytes: 128, enabled: true } },
  })
  assert.equal(result.body.ok, true)
  assert.equal(ctx.written.length, 1)
  assert.equal(ctx.written[0].entryId, 'image-size-guard')
  const saved = ctx.written[0].next.providers
  assert.equal(saved.length, 1, 'an existing provider is replaced, not duplicated')
  assert.equal(saved[0].maxRequestBytes, 8 * MiB)
}

// ---- save appends a new provider ----
{
  const ctx = fakeContext()
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, { endpoint: 'limits.save', payload: { limit: { provider: 'openscg', maxRequestBytes: 4 * MiB } } })
  assert.equal(result.body.ok, true)
  const saved = ctx.written[0].next.providers
  assert.deepEqual(saved.map((row) => row.provider), ['agent2api', 'openscg'])
  assert.equal(saved[1].reserveBytes, 256 * 1024, 'omitted fields take their defaults')
}

// ---- remove deletes exactly one row ----
{
  const ctx = fakeContext({
    config: resolveConfig({
      providers: [
        { provider: 'agent2api', maxRequestBytes: 16 * MiB },
        { provider: 'openscg', maxRequestBytes: 8 * MiB },
      ],
    }),
  })
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, { endpoint: 'limits.remove', payload: { provider: 'openscg' } })
  assert.equal(result.body.ok, true)
  assert.deepEqual(ctx.written[0].next.providers.map((row) => row.provider), ['agent2api'])
}

// ---- rejections are reported, not thrown ----
{
  const ctx = fakeContext()
  mountRpc(ctx, () => ctx.config)

  const missing = await call(ctx, { endpoint: 'limits.save', payload: {} })
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.error.message, /limit object is required/i)

  const blank = await call(ctx, { endpoint: 'limits.save', payload: { limit: { provider: '   ' } } })
  assert.equal(blank.body.ok, false)
  assert.match(blank.body.error.message, /provider route name is required/i)

  const badReserve = await call(ctx, {
    endpoint: 'limits.save',
    payload: { limit: { provider: 'x', maxRequestBytes: 100, reserveBytes: 100 } },
  })
  assert.equal(badReserve.body.ok, false)
  assert.match(badReserve.body.error.message, /reserveBytes must be smaller/)

  const unknown = await call(ctx, { endpoint: 'limits.nope' })
  assert.equal(unknown.body.ok, false)
  assert.match(unknown.body.error.message, /Unknown endpoint/)

  assert.equal(ctx.written.length, 0, 'a rejected request writes nothing')
}

// ---- admission is enforced before anything is read ----
{
  const ctx = fakeContext({ admitted: false })
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, { endpoint: 'limits.list' })
  assert.equal(result.status, 401, 'an unauthenticated caller is refused')
  assert.equal(result.body, 'unauthorized', 'and learns nothing about the limits')
}

// ---- method and content type are enforced ----
{
  const ctx = fakeContext()
  mountRpc(ctx, () => ctx.config)
  assert.equal((await call(ctx, {}, { method: 'GET' })).status, 405)
  assert.equal((await call(ctx, {}, { contentType: 'text/plain' })).status, 415)
}

// ---- without a config editor, saving reports why instead of crashing ----
{
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { ctx.route = route; return () => {} } }
      if (name === 'connection') return { admit: () => ({ peer: {} }) }
      return undefined
    },
  }
  mountRpc(ctx, () => resolveConfig(undefined))
  const result = await call(ctx, { endpoint: 'limits.save', payload: { limit: { provider: 'p' } } })
  assert.equal(result.body.ok, false)
  assert.match(result.body.error.message, /cannot persist/i)
}

// ---- without the web carrier, mounting is a no-op ----
{
  let asked = []
  const ctx = {
    get(name) {
      asked.push(name)
      return undefined
    },
  }
  const dispose = mountRpc(ctx, () => resolveConfig(undefined))
  assert.equal(typeof dispose, 'function')
  assert.ok(asked.includes('webServer'))
}

console.log('all rpc tests passed')
