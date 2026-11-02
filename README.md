# dsh-image-size-guard

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It
keeps model requests under a gateway's request-body ceiling by replacing the
oldest history images with placeholder text — in one batch that lands the body
on a low-water mark below the ceiling, so the following turns stay under it
without rewriting history again.

Written for the `agent2api` gateway, whose 16 MiB request-body limit rejects a
conversation once its accumulated images grow past it. At that point the session
can never complete another request, and nothing in the Harness recovers it: the
adapter's own image budget defaults to 20 MiB and never trips, the gateway's 413
arrives as a non-retryable `INVALID_REQUEST`, and the session is stuck.

## What it does

Every model request carries the whole history, and every image in that history is
re-encoded into every request body. A long conversation therefore grows without
bound, and eventually no request fits.

When a request for a guarded provider would exceed the budget, this plugin:

1. measures the request body, using the adapter's own cached request-image
   versions so the image bytes are the ones actually sent;
2. works out how many of the oldest image occurrences must go: it retires enough
   of them to land on a target below the ceiling, sized from recent per-turn
   growth, and leaves the newest turns' images alone;
3. ends the attempt with a terminal failure, which the agent loop retries;
4. the retry rebuilds the request from the session surface, which now carries the
   omission — so the next measurement is of a genuinely smaller body.

### Why a batch, not the minimum

Every omission rewrites an old message, and a provider's prefix cache matches the
longest common prefix — so each omission invalidates the cache from that image
onward. Retiring exactly one image per turn means hitting the ceiling again on
the very next turn and paying a full re-prefill *every* turn: the cheapest
possible deletion is the most expensive possible cache behaviour.

Retiring a batch pays that cost once every few turns instead, for the same total
number of images retired. Under a 10 MiB ceiling, eight turns of one 1 MiB
screenshot each now retire six images in one go, leaving ~2.7 MiB and about five
quiet turns; the minimal policy retired one image, landed on 9.3 MiB, and
triggered again immediately.

Three numbers shape the batch:

- `targetTurns` (default `5`) — how many turns of growth one deletion should buy.
- `minFillPercent` (default `40`) — the floor: a batch never drops the body below
  this share of the budget, however large the growth estimate looks.
- `protectedTurns` (default `2`) — the newest turns keep their images; they are
  only retired when the request would otherwise exceed the ceiling anyway.

A request that already fits is never trimmed, even when it sits above the
low-water mark.

## Install

```sh
dsh plugin --profile web add dsh-image-size-guard
```

Or from a checkout:

```sh
dsh plugin --profile web add /path/to/dsh-image-size-guard
```

The bundle inserts its Host row and its Settings page. Restart the Harness once
after the first install so the browser picks up the new client module.

## Usage

Open **Settings → Image size guard**. The page lists one row per guarded provider
and supports add, edit, remove, and enable/disable.

| Field | Meaning |
| --- | --- |
| Provider | The provider route name, such as `agent2api`. |
| Request limit (MiB) | The largest request body that provider accepts. Decimals are allowed (`10.5`). |
| Reserve (KiB) | Headroom kept free below the limit. |
| Placeholder size (bytes) | Bytes one omitted image is estimated to occupy. |
| Enabled | Whether the guard acts on this provider. |

Each row carries a switch on the right. Flipping it saves the row with only
`enabled` changed, so the limit never has to be retyped, and a disabled row stops
guarding immediately — its requests pass through untouched. The row also dims, so
a switched-off provider reads as off at a glance. The switch is a real
`role="switch"` button, so it answers to Enter and Space and reports its state to
screen readers.

Each size is edited in the unit its field names, so a value never has to be converted by hand: the default row reads `16` / `256` / `512`. The stored values stay exact bytes; the panel converts on open and on save.

The page also offers the providers the LLM registry advertises that no row covers
yet, so a new provider is one click away instead of a typed guess.

Saving writes the profile patch layer through `configEditor.edit`, which validates
with this plugin's own `Config` and reconciles the Loader. The guard and the panel
therefore read one source of truth, and a save takes effect without restarting the
Harness. Removing the last row is allowed: it means no provider is guarded.

The panel talks to `POST /image-size-guard/limits`. The Host admits each request
through `connection.admit`, so it carries the same Host/Origin checks and browser
session as the rest of the API.

## Configuration

The panel edits this row; the YAML below is the same value in file form.

```yaml
- insert:
    - id: image-size-guard
      name: 'dsh-image-size-guard'
      config:
        providers:
          - provider: agent2api
            maxRequestBytes: 16777216
            reserveBytes: 262144
            placeholderBytes: 512
            targetTurns: 5
            minFillPercent: 40
            protectedTurns: 2
            growthWindow: 8
            enabled: true
```

| Key | Default | Meaning |
| --- | --- | --- |
| `providers` | one `agent2api` row | Provider limit rows. Omit the field for that default; an explicit empty list guards nothing. |
| `providers[].provider` | — | Provider route name. |
| `providers[].maxRequestBytes` | `16777216` (16 MiB) | The gateway's request-body ceiling. |
| `providers[].reserveBytes` | `262144` (256 KiB) | Headroom kept free below the ceiling. |
| `providers[].placeholderBytes` | `512` | Bytes assumed for one placeholder block. |
| `providers[].targetTurns` | `5` | Turns of growth one batch should buy below the ceiling. `0` disables batching and restores the minimal policy. |
| `providers[].minFillPercent` | `40` | Lowest share of the budget, in percent, a batch may leave behind. |
| `providers[].protectedTurns` | `2` | Newest turns whose images a batch leaves alone. `0` protects nothing. |
| `providers[].growthWindow` | `8` | Turns sampled to estimate per-turn growth. |
| `providers[].enabled` | `true` | Whether the guard acts on this provider. |

The budget a request is measured against is `maxRequestBytes - reserveBytes`. The
reserve exists because the estimate models the JSON body, not the provider
envelope or HTTP headers, which are invisible at this seam.

## Two execution paths

The omission is a durable `image/offload` record. Two implementations can exist,
and the plugin picks one at startup:

| Mounted executor | Who writes the record | Signal the attempt ends with |
| --- | --- | --- |
| `@deepseek-ai/dsh-compaction-image-offload` | the shipped executor | `IMAGE_OFFLOAD_REQUIRED` |
| none | this plugin | `REQUEST_TOO_LARGE` |

The shipped executor already listens for `IMAGE_OFFLOAD_REQUIRED`, so when it is
present the plugin only *asks*: it yields a finish chunk carrying that code and a
positive `offloadImages` count, and the executor writes the record and returns the
retry action. That keeps one implementation of the selection and its projection,
and follows the harness when its format changes.

When the executor is absent, the plugin falls back to its own record writer and
its own `REQUEST_TOO_LARGE` retry, so a profile without that bundle still works.
The presence test is the registered `image/offload` projection, which the executor
contributes on mount.

**The signal is yielded, not thrown.** A thrown error from an `llm/stream`
listener propagates out of `llm.stream()` and the agent loop re-throws it before
the `agent/request-error` waterfall runs, so the executor would never see it. A
`finish` chunk with an error reason does reach that waterfall; the adapter
produces the same chunk by turning a thrown `IMAGE_OFFLOAD_REQUIRED` into it.

## Why the omission is durable

The selection is recorded as the Session's own `image/offload` event, so it
survives resume, fork, and compaction, and it is visible to the token meter and
the GUI. The placeholder text the model sees is the adapter's standard "image
omitted" handle, which names the attachment and its recovery path.

The plugin contributes the `image/offload` projection only when the shipped bundle
has not already registered it; its definition is byte-compatible with that
package's, so the two can coexist and a session log written by either restores
under both.

## Limits

- A request whose **text alone** exceeds the budget is sent unchanged, with a
  warning. There is nothing left to omit, and blocking the turn would be worse
  than letting the gateway decide.
- The estimate covers `system`, `messages`, and `tools`. Adapter-specific fields
  outside that set are covered by the reserve, not measured.
- Only images are omitted. Tool results, reasoning blocks, and text are never
  altered.
- The guard acts before the request leaves the process. A gateway that rejects on
  something this estimate cannot see — a compressed size, a header limit — is
  outside what it can prevent.

## Uninstall

```sh
dsh plugin --profile web remove dsh-image-size-guard
```

Session logs that already contain `image/offload` events keep replaying: the
shipped `@deepseek-ai/dsh-compaction-image-offload` bundle owns that projection,
and a profile without it falls back to this plugin only while the plugin is
installed. If you remove the plugin from a profile that has neither, restore the
bundle before resuming those sessions.

## Develop

No build step and no dependencies: plain ESM on the Host, a plain browser module
on the Client.

```sh
for test in test/*.test.mjs; do node "$test"; done
```

- `estimate` — request measurement, growth-based low-water sizing, and the batch decision.
- `config` — the limit schema, defaults, and every rejection.
- `offload` — the durable `image/offload` projection and selection order.
- `plugin` — the guard's wiring: pass-through, omission, retry, failure paths.
- `deference` — both execution paths: ask the shipped executor, or do it alone.
- `rpc` — the panel endpoint: admission, methods, list/save/remove, rejections.
- `mount` — the endpoint mounts even when its carrier services arrive late.
- `save-path` — that a saved row survives the Loader's own validation.
- `client` — the browser bundle's exports and slot registration.
- `client.render` — the panel's real element tree, text, and form behavior.
- `switch` — clicking a row's switch asks the Host for the inverted state.
- `toggle` — that toggle round-trips through the Host and persists.

Layout:

```
lib/index.js      the guard: measurement, signal, retry wiring
lib/estimate.js   request-body measurement, growth sizing, and the batch decision
lib/config.js     limit schema, defaults, budget arithmetic
lib/offload.js    the image/offload projection and selection (fallback path)
lib/rpc.js        the Settings panel endpoint
client/client.js  the Settings page
locale/{en,zh}.json
```

## License

MIT
