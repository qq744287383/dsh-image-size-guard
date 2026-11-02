import assert from 'node:assert/strict'
import { mountRpc } from '../lib/rpc.js'
import { resolveConfig } from '../lib/config.js'

/**
 * Exercise the save path the way the running Host does: the endpoint computes
 * the next config and hands it to `configEditor.edit`, which validates it
 * through this plugin's own `Config` before persisting. A config the Loader
 * would reject must therefore be rejected here, not at the next reload.
 */

/** The same validation the Loader performs on a row's config. */
function loaderValidation(value) {
  return resolveConfig(value)
}

function makeContext({ config, failOnEdit } = {}) {
  const written = []
  const ctx = {
    written,
    get(name) {
      if (name === 'webServer') return { register: (route) => { ctx.route = route; return () => {} } }
      if (name === 'connection') return { admit: () => ({ peer: {} }) }
      if (name === 'llm') return { listProviders: () => [] }
      if (name === 'configEditor') {
        return {
          entries: () => [{ options: { id: 'image-size-guard' } }],
          async edit(entry, change) {
            const persisted = ctx.persisted ?? {}
            const next = change(persisted, {})
            ctx.persisted = next
            // The Loader re-validates before writing; a bad config must not
            // reach the file.
            loaderValidation(next)
            if (failOnEdit !== undefined) throw failOnEdit
            written.push(next)
          },
        }
      }
      return undefined
    },
  }
  ctx.config = config ?? resolveConfig(undefined)
  // The row's persisted config is what the editor hands the callback; seed it
  // with the same value so the first save sees a realistic starting point.
  ctx.persisted = { providers: ctx.config.providers.map((limit) => ({ ...limit })) }
  return ctx
}

function request(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
    destroy() {},
  }
}

async function call(ctx, body) {
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(value) {
      this.body = value ?? ''
    },
  }
  await ctx.route.handler(request(body), res)
  return res.body === '' ? undefined : JSON.parse(res.body)
}

// ---- a saved row round-trips through the Loader's validation ----
{
  const ctx = makeContext()
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, {
    endpoint: 'limits.save',
    payload: { limit: { provider: 'openscg', maxRequestBytes: 8 * 1024 * 1024, reserveBytes: 4096, placeholderBytes: 256, enabled: true } },
  })
  assert.equal(result.ok, true)
  assert.equal(ctx.written.length, 1)

  // What the Loader will hand the plugin on the next reload.
  const reloaded = resolveConfig(ctx.written[0])
  const row = reloaded.providers.find((entry) => entry.provider === 'openscg')
  assert.ok(row, 'the saved row survives a reload')
  assert.equal(row.maxRequestBytes, 8 * 1024 * 1024)
  assert.equal(row.reserveBytes, 4096)
  assert.equal(row.placeholderBytes, 256)
}

// ---- every saved row is a valid config on its own ----
{
  const ctx = makeContext()
  mountRpc(ctx, () => ctx.config)
  await call(ctx, { endpoint: 'limits.save', payload: { limit: { provider: 'a', maxRequestBytes: 1024, reserveBytes: 100 } } })
  await call(ctx, { endpoint: 'limits.save', payload: { limit: { provider: 'b', maxRequestBytes: 2048, reserveBytes: 100 } } })
  const reloaded = resolveConfig(ctx.written.at(-1))
  assert.deepEqual(reloaded.providers.map((entry) => entry.provider), ['agent2api', 'a', 'b'])
}

// ---- a rejected save never reaches the Loader ----
{
  const ctx = makeContext()
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, {
    endpoint: 'limits.save',
    payload: { limit: { provider: 'x', maxRequestBytes: 1024, reserveBytes: 2048 } },
  })
  assert.equal(result.ok, false)
  assert.equal(ctx.written.length, 0, 'an unusable limit is not persisted')
}

// ---- a Loader failure is reported to the panel, not thrown into the route ----
{
  const ctx = makeContext({ failOnEdit: new Error('Configuration entry is no longer available') })
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, { endpoint: 'limits.save', payload: { limit: { provider: 'y' } } })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /no longer available/)
}

// ---- removing the last row leaves a valid (empty) config ----
{
  const ctx = makeContext({
    config: resolveConfig({ providers: [{ provider: 'solo', maxRequestBytes: 1024, reserveBytes: 10 }] }),
  })
  mountRpc(ctx, () => ctx.config)
  const result = await call(ctx, { endpoint: 'limits.remove', payload: { provider: 'solo' } })
  assert.equal(result.ok, true)
  const reloaded = resolveConfig(ctx.written[0])
  assert.deepEqual(reloaded.providers, [], 'no providers means nothing is guarded, which is valid')
}

console.log('all save-path tests passed')
