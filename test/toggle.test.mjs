import assert from 'node:assert/strict'
import { mountRpc } from '../lib/rpc.js'
import { resolveConfig, activeLimits } from '../lib/config.js'

/**
 * The switch on a provider row must round-trip through the Host: flipping it
 * saves the row with `enabled` inverted and leaves every other field alone.
 *
 * This drives the real endpoint rather than the component, because the question
 * is whether the state the user sees comes back from storage — not whether a
 * handler is attached.
 */

const MiB = 1024 * 1024

function makeContext(config) {
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
            const next = change(ctx.persisted, {})
            ctx.persisted = next
            written.push(next)
          },
        }
      }
      return undefined
    },
  }
  ctx.config = resolveConfig(config)
  ctx.persisted = { providers: ctx.config.providers.map((row) => ({ ...row })) }
  return ctx
}

async function post(ctx, body) {
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
    destroy() {},
  }
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
  await ctx.route.handler(req, res)
  return JSON.parse(res.body)
}

const startingRow = {
  provider: 'agent2api',
  maxRequestBytes: 16 * MiB,
  reserveBytes: 256 * 1024,
  placeholderBytes: 512,
  enabled: true,
}

// ---- switching off keeps the limit and only flips the flag ----
{
  const ctx = makeContext({ providers: [startingRow] })
  mountRpc(ctx, () => ctx.config)
  const result = await post(ctx, { endpoint: 'limits.save', payload: { limit: { ...startingRow, enabled: false } } })

  assert.equal(result.ok, true)
  assert.equal(result.value.providers.length, 1, 'toggling never adds or removes a row')
  const saved = result.value.providers[0]
  assert.equal(saved.enabled, false)
  assert.equal(saved.maxRequestBytes, 16 * MiB, 'the limit survives a toggle')
  assert.equal(saved.reserveBytes, 256 * 1024)
  assert.equal(saved.placeholderBytes, 512)

  // What the Loader will hand the guard on the next reload.
  const reloaded = resolveConfig(ctx.persisted)
  assert.equal(reloaded.providers[0].enabled, false)
}

// ---- a disabled row guards nothing; re-enabling restores it ----
{
  const ctx = makeContext({ providers: [startingRow] })
  mountRpc(ctx, () => ctx.config)

  await post(ctx, { endpoint: 'limits.save', payload: { limit: { ...startingRow, enabled: false } } })
  assert.equal(activeLimits(resolveConfig(ctx.persisted)).size, 0, 'a disabled row is inert')

  const back = await post(ctx, { endpoint: 'limits.save', payload: { limit: { ...startingRow, enabled: true } } })
  assert.equal(back.value.providers[0].enabled, true)
  const active = activeLimits(resolveConfig(ctx.persisted))
  assert.equal(active.size, 1, 're-enabling restores the guard')
  assert.equal(active.get('agent2api').maxRequestBytes, 16 * MiB)
}

// ---- toggling one provider leaves its neighbours untouched ----
{
  const other = { provider: 'openscg', maxRequestBytes: 8 * MiB, reserveBytes: 1024, placeholderBytes: 128, enabled: true }
  const ctx = makeContext({ providers: [startingRow, other] })
  mountRpc(ctx, () => ctx.config)

  const result = await post(ctx, { endpoint: 'limits.save', payload: { limit: { ...other, enabled: false } } })
  const rows = result.value.providers
  assert.deepEqual(rows.map((row) => row.provider), ['agent2api', 'openscg'])
  assert.equal(rows[0].enabled, true, 'the untouched provider stays enabled')
  assert.equal(rows[1].enabled, false)
  assert.equal(activeLimits(resolveConfig(ctx.persisted)).size, 1)
}

// ---- a toggled row still passes the Loader's validation ----
{
  const ctx = makeContext({ providers: [startingRow] })
  mountRpc(ctx, () => ctx.config)
  await post(ctx, { endpoint: 'limits.save', payload: { limit: { ...startingRow, enabled: false } } })
  // `resolveConfig` is the same validation the Loader applies; reaching here
  // without a throw means the persisted value is loadable.
  assert.doesNotThrow(() => resolveConfig(ctx.persisted))
}

// ---- an invalid toggle is refused and writes nothing ----
{
  const ctx = makeContext({ providers: [startingRow] })
  mountRpc(ctx, () => ctx.config)
  const result = await post(ctx, {
    endpoint: 'limits.save',
    payload: { limit: { ...startingRow, enabled: false, reserveBytes: 32 * MiB } },
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /reserveBytes must be smaller/)
  assert.equal(ctx.written.length, 0)
}

console.log('all toggle tests passed')
