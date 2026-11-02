window.__ModuleLoader__.load({
  id: 'dsh-image-size-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'settings.imageSizeGuard'
    const RPC_PATH = '/image-size-guard/limits'
    const ENDPOINTS = { list: 'limits.list', save: 'limits.save', remove: 'limits.remove' }
    const MiB = 1024 * 1024
    const KiB = 1024

    // ---- text ------------------------------------------------------------
    const zh = {
      nav: '图片体积守卫',
      title: '图片体积守卫',
      intro:
        '模型供应商给网关设定了请求大小，超过就会报错拒绝处理。本插件给模型供应商的请求限制大小，当发请求前请求体大小大于设定值后会触发 dsh 官方自带的图片卸载功能（通过图片路径或说明代替图片本身），以确保请求大小不会超过设定值。',
      provider: '供应商',
      providerHint: '供应商路由名，例如 agent2api',
      limit: '请求上限',
      limitHint: '网关接受的请求体最大值，可填小数',
      reserve: '预留空间',
      reserveHint: '在上限下留出的余量，用于 HTTP 头和估算误差',
      placeholder: '占位大小',
      placeholderHint: '一张图片被省略后，估算占用的字节数',
      enabled: '启用',
      enabledOn: '已启用',
      enabledOff: '已停用',
      budget: '实际可用',
      add: '添加供应商',
      edit: '编辑',
      save: '保存',
      saving: '正在保存…',
      cancel: '取消',
      remove: '移除',
      removeTitle: '移除供应商限制',
      removeBody: '移除后，该供应商的请求不再受本插件保护。',
      empty: '还没有配置任何供应商。',
      emptyAdvertised: '从下面选择一个供应商开始：',
      loading: '正在加载…',
      loadFailed: '无法加载供应商限制。',
      retry: '重试',
      invalidNumber: '请填一个正数（可带小数）。',
      reserveTooBig: '预留空间必须小于请求上限。',
      placeholderTooBig: '占位大小必须小于请求上限。',
      duplicate: '这个供应商已经有一份限制了。',
      bytes: '字节',
      mib: 'MiB',
      batching: '批量删除策略',
      batchingHint:
        '每删一张图都会从那个位置起打断上下文缓存。一次多删几张、把请求压到更低的水位，可以换来多轮缓存命中。',
      targetTurns: '目标余量（轮）',
      targetTurnsHint: '一次删除预计撑过多少轮；0 表示关闭批量，只删到刚好够',
      minFillPercent: '最低水位（%）',
      minFillPercentHint: '批量删除后至少保留的预算比例',
      protectedTurns: '保护最近（轮）',
      protectedTurnsHint: '这几轮的图片不主动删除，除非不删就发不出去',
      growthWindow: '增长窗口（轮）',
      growthWindowHint: '用最近几轮估算每轮增长',
      batchingShort: '批量',
      protectShort: '保护',
      turnsUnit: ' 轮',
      off: '关闭',
      invalidCount: '这些字段要填整数（轮数可以填 0）。',
      invalidPercent: '最低水位要在 1 到 100 之间。',
    }
    const en = {
      nav: 'Image size guard',
      title: 'Image size guard',
      intro:
        'Model providers set a request size on the gateway, and anything larger is rejected with an error. This plugin sets a request-size limit per model provider: before a request is sent, if its body is larger than the configured value, the harness built-in image offloading kicks in (replacing the image itself with its image path or a note), so the request stays under the configured size.',
      provider: 'Provider',
      providerHint: 'Provider route name, such as agent2api',
      limit: 'Request limit',
      limitHint: 'Largest request body the gateway accepts; decimals allowed',
      reserve: 'Reserve',
      reserveHint: 'Headroom below the limit for HTTP headers and estimate error',
      placeholder: 'Placeholder size',
      placeholderHint: 'Bytes one omitted image is estimated to occupy',
      enabled: 'Enabled',
      enabledOn: 'Enabled',
      enabledOff: 'Disabled',
      budget: 'Effective budget',
      add: 'Add provider',
      edit: 'Edit',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      remove: 'Remove',
      removeTitle: 'Remove provider limit',
      removeBody: 'Requests to this provider will no longer be guarded by this plugin.',
      empty: 'No providers are configured yet.',
      emptyAdvertised: 'Pick a provider to start:',
      loading: 'Loading…',
      loadFailed: 'Could not load provider limits.',
      retry: 'Retry',
      invalidNumber: 'Enter a positive number; decimals are allowed.',
      reserveTooBig: 'The reserve must be smaller than the request limit.',
      placeholderTooBig: 'The placeholder size must be smaller than the request limit.',
      duplicate: 'This provider already has a limit.',
      bytes: 'bytes',
      mib: 'MiB',
      batching: 'Batch deletion',
      batchingHint:
        'Every omission breaks the prompt cache from that image onward. Deleting several at once and landing lower buys several cache-warm turns.',
      targetTurns: 'Headroom (turns)',
      targetTurnsHint: 'Turns one deletion should cover; 0 disables batching and deletes only what the ceiling needs',
      minFillPercent: 'Low-water mark (%)',
      minFillPercentHint: 'Share of the budget a batch keeps after deleting',
      protectedTurns: 'Protect last (turns)',
      protectedTurnsHint: 'Images this recent are only deleted when nothing else fits',
      growthWindow: 'Growth window (turns)',
      growthWindowHint: 'Turns sampled to estimate per-turn growth',
      batchingShort: 'Batch',
      protectShort: 'Protect',
      turnsUnit: ' turns',
      off: 'off',
      invalidCount: 'These fields need whole numbers (turn counts may be 0).',
      invalidPercent: 'The low-water mark must be between 1 and 100.',
    }

    // ---- styles ----------------------------------------------------------
    const STYLE_ID = 'dsh-image-size-guard-styles'
    const CSS = `
.dsg-root { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary); }
.dsg-intro { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.dsg-list { display: flex; flex-direction: column; gap: 8px; }
.dsg-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsg-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dsg-provider { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsg-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsg-switch { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; border-radius: 6px; background: 0 0; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.dsg-switch[aria-checked="true"] { color: var(--dsw-alias-label-primary); }
.dsg-switch:disabled { color: var(--dsw-alias-label-secondary); opacity: .6; cursor: default; }
.dsg-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsg-switch-track { position: relative; display: inline-block; flex: none; width: 26px; height: 14px; border-radius: 7px; background: var(--dsw-alias-border-l2); transition: background-color .12s ease-in-out; }
.dsg-switch-track[data-on] { background: var(--dsw-alias-state-success-primary); }
.dsg-switch-thumb { position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1); transition: transform .12s ease-in-out; }
.dsg-switch-track[data-on] .dsg-switch-thumb { transform: translateX(12px); }
.dsg-row-off .dsg-provider, .dsg-row-off .dsg-meta { opacity: .65; }
.dsg-actions { display: flex; gap: 6px; }
.dsg-btn { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dsg-btn:disabled { opacity: .5; cursor: default; }
.dsg-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsg-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsg-form { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsg-field { display: flex; flex-direction: column; gap: 4px; }
.dsg-label { font-size: 12px; font-weight: 600; }
.dsg-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsg-input { font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsg-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsg-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dsg-inline { display: flex; align-items: center; gap: 8px; }
.dsg-empty { padding: 20px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; }
.dsg-suggest { display: flex; flex-wrap: wrap; gap: 6px; }
.dsg-mib { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsg-group { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsg-group-title { font-size: 12px; font-weight: 600; }
.dsg-group-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
`

    function mountStyles() {
      if (document.getElementById(STYLE_ID)) return () => {}
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
      return () => el.remove()
    }

    // ---- helpers ---------------------------------------------------------
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      const mib = bytes / MiB
      return `${mib.toFixed(mib >= 100 ? 0 : mib >= 10 ? 1 : 2)} MiB`
    }

    function parsePositive(value) {
      const trimmed = String(value).trim()
      if (!/^\d+$/.test(trimmed)) return undefined
      const parsed = Number(trimmed)
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
    }

    /**
     * Parse a whole-number count, optionally accepting zero.
     * @returns the count, or undefined when the text is not a usable integer.
     */
    function parseCount(value, allowZero = false) {
      const trimmed = String(value).trim()
      if (!/^\d+$/.test(trimmed)) return undefined
      const parsed = Number(trimmed)
      if (!Number.isSafeInteger(parsed)) return undefined
      return allowZero ? parsed : parsed > 0 ? parsed : undefined
    }

    /**
     * Parse a positive amount that may carry a decimal part, in whole units.
     * Accepts `16`, `10.5`, and `.25`; rejects negatives, exponents, and junk.
     * @returns the amount, or undefined when the text is not a usable number.
     */
    function parseAmount(value) {
      const trimmed = String(value).trim()
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return undefined
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }

    /**
     * Turn a displayed amount expressed in `unit` bytes into the exact byte count
     * the Host stores, rounding the fractional bytes a decimal input produces.
     * @returns the byte count, or undefined when it is not a usable positive integer.
     */
    function toBytes(amount, unit) {
      if (amount === undefined) return undefined
      const bytes = Math.round(amount * unit)
      return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined
    }

    /**
     * Render a byte count in `unit` bytes for an input field: no trailing zeros
     * and no suffix, because the field label carries the unit.
     * @returns the amount as an input-ready string.
     */
    function fromBytes(bytes, unit) {
      const amount = bytes / unit
      return String(Number(amount.toFixed(4)))
    }

    /** Render one editable provider row, or a read-only summary. */
    function LimitRow({ limit, t, busy, onEdit, onRemove, onToggle }) {
      const budget = limit.maxRequestBytes - limit.reserveBytes
      return h(
        'div',
        { className: `dsg-row${limit.enabled ? '' : ' dsg-row-off'}` },
        h(
          'div',
          { className: 'dsg-row-main' },
          h('div', { className: 'dsg-provider' }, limit.provider),
          h(
            'div',
            { className: 'dsg-meta' },
            `${t('limit')} ${formatBytes(limit.maxRequestBytes)} · ${t('budget')} ${formatBytes(budget)}`,
          ),
          // The batch policy is what decides how often history is rewritten,
          // so it belongs on the row rather than only inside the form.
          limit.targetTurns === undefined
            ? null
            : h(
                'div',
                { className: 'dsg-meta' },
                `${t('batchingShort')} ${limit.targetTurns > 0 ? `${limit.targetTurns}${t('turnsUnit')}` : t('off')} · ${t('protectShort')} ${limit.protectedTurns}${t('turnsUnit')}`,
              ),
        ),
        // A real switch: the same `role="switch"` + track/thumb pattern the
        // host uses, so keyboard and screen-reader behavior match.
        h(
          'button',
          {
            type: 'button',
            className: 'dsg-switch',
            role: 'switch',
            'aria-checked': limit.enabled,
            'aria-label': `${limit.provider}: ${limit.enabled ? t('enabledOn') : t('enabledOff')}`,
            title: limit.enabled ? t('enabledOn') : t('enabledOff'),
            disabled: busy,
            onClick: () => onToggle(limit),
          },
          h('span', { className: 'dsg-switch-label' }, limit.enabled ? t('enabledOn') : t('enabledOff')),
          h(
            'span',
            { className: 'dsg-switch-track', 'data-on': limit.enabled || undefined, 'aria-hidden': 'true' },
            h('span', { className: 'dsg-switch-thumb' }),
          ),
        ),
        h(
          'div',
          { className: 'dsg-actions' },
          h('button', { type: 'button', className: 'dsg-btn', disabled: busy, onClick: () => onEdit(limit) }, t('edit')),
          h(
            'button',
            { type: 'button', className: 'dsg-btn dsg-btn-danger', disabled: busy, onClick: () => onRemove(limit) },
            t('remove'),
          ),
        ),
      )
    }

    /** The add/edit form for one provider limit. */
    function LimitForm({ initial, t, busy, existing, onCancel, onSave }) {
      const [provider, setProvider] = useState(initial?.provider ?? '')
      // Each field is edited in the unit its value is naturally expressed in:
      // MiB for a request ceiling, KiB for the headroom beneath it, bytes for
      // the tiny placeholder. Stored values are always exact bytes.
      const [limit, setLimit] = useState(() => fromBytes(initial?.maxRequestBytes ?? 16 * MiB, MiB))
      const [reserve, setReserve] = useState(() => fromBytes(initial?.reserveBytes ?? 256 * 1024, KiB))
      const [placeholder, setPlaceholder] = useState(() => fromBytes(initial?.placeholderBytes ?? 512, 1))
      // Batch policy: how many images one trigger retires, and which recent
      // turns keep theirs. Whole turns and a percentage, so no unit hints.
      const [targetTurns, setTargetTurns] = useState(String(initial?.targetTurns ?? 5))
      const [minFill, setMinFill] = useState(String(initial?.minFillPercent ?? 40))
      const [protectedTurns, setProtectedTurns] = useState(String(initial?.protectedTurns ?? 2))
      const [growthWindow, setGrowthWindow] = useState(String(initial?.growthWindow ?? 8))
      const [enabled, setEnabled] = useState(initial?.enabled ?? true)
      const [error, setError] = useState('')

      const isNew = initial === undefined

      function submit(event) {
        event.preventDefault()
        const name = provider.trim()
        if (name.length === 0) return setError(t('providerHint'))
        const nextLimit = toBytes(parseAmount(limit), MiB)
        const nextReserve = toBytes(parseAmount(reserve), KiB)
        const nextPlaceholder = toBytes(parseAmount(placeholder), 1)
        if (nextLimit === undefined || nextReserve === undefined || nextPlaceholder === undefined) {
          return setError(t('invalidNumber'))
        }
        if (nextReserve >= nextLimit) return setError(t('reserveTooBig'))
        if (nextPlaceholder >= nextLimit) return setError(t('placeholderTooBig'))
        const nextTargetTurns = parseCount(targetTurns, true)
        const nextMinFill = parseCount(minFill)
        const nextProtectedTurns = parseCount(protectedTurns, true)
        const nextGrowthWindow = parseCount(growthWindow)
        if (
          nextTargetTurns === undefined ||
          nextMinFill === undefined ||
          nextProtectedTurns === undefined ||
          nextGrowthWindow === undefined
        ) {
          return setError(t('invalidCount'))
        }
        if (nextMinFill > 100) return setError(t('invalidPercent'))
        if (isNew && existing.some((row) => row.provider === name)) return setError(t('duplicate'))
        setError('')
        onSave({
          provider: name,
          maxRequestBytes: nextLimit,
          reserveBytes: nextReserve,
          placeholderBytes: nextPlaceholder,
          targetTurns: nextTargetTurns,
          minFillPercent: nextMinFill,
          protectedTurns: nextProtectedTurns,
          growthWindow: nextGrowthWindow,
          enabled,
        })
      }

      const field = (labelText, hintText, value, setValue, inputMode = 'decimal') =>
        h(
          'label',
          { className: 'dsg-field' },
          h('span', { className: 'dsg-label' }, labelText),
          h('input', {
            className: 'dsg-input',
            value,
            inputMode,
            onChange: (event) => setValue(event.target.value),
          }),
          hintText === undefined ? null : h('span', { className: 'dsg-hint' }, hintText),
        )

      return h(
        'form',
        { className: 'dsg-form', onSubmit: submit },
        h(
          'label',
          { className: 'dsg-field' },
          h('span', { className: 'dsg-label' }, t('provider')),
          h('input', {
            className: 'dsg-input',
            value: provider,
            disabled: !isNew,
            onChange: (event) => setProvider(event.target.value),
          }),
          h('span', { className: 'dsg-hint' }, t('providerHint')),
        ),
        field(
          `${t('limit')} (MiB)`,
          `${t('limitHint')} — ${formatBytes(toBytes(parseAmount(limit), MiB) ?? 0)}`,
          limit,
          setLimit,
        ),
        field(
          `${t('reserve')} (KiB)`,
          `${t('reserveHint')} — ${formatBytes(toBytes(parseAmount(reserve), KiB) ?? 0)}`,
          reserve,
          setReserve,
        ),
        field(`${t('placeholder')} (${t('bytes')})`, t('placeholderHint'), placeholder, setPlaceholder, 'numeric'),
        h(
          'div',
          { className: 'dsg-group' },
          h('div', { className: 'dsg-group-title' }, t('batching')),
          h('div', { className: 'dsg-group-hint' }, t('batchingHint')),
          h(
            'div',
            { className: 'dsg-grid' },
            field(`${t('targetTurns')}`, t('targetTurnsHint'), targetTurns, setTargetTurns, 'numeric'),
            field(`${t('minFillPercent')}`, t('minFillPercentHint'), minFill, setMinFill, 'numeric'),
            field(`${t('protectedTurns')}`, t('protectedTurnsHint'), protectedTurns, setProtectedTurns, 'numeric'),
            field(`${t('growthWindow')}`, t('growthWindowHint'), growthWindow, setGrowthWindow, 'numeric'),
          ),
        ),
        h(
          'label',
          { className: 'dsg-inline' },
          h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
          h('span', { className: 'dsg-label' }, t('enabled')),
        ),
        error === '' ? null : h('div', { className: 'dsg-error' }, error),
        h(
          'div',
          { className: 'dsg-actions' },
          h('button', { type: 'submit', className: 'dsg-btn dsg-btn-primary', disabled: busy }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'dsg-btn', disabled: busy, onClick: onCancel }, t('cancel')),
        ),
      )
    }

    /** The settings page: a provider list plus add/edit/remove. */
    function ImageSizeGuardSection({ t, rpcCall }) {
      const [state, setState] = useState({ status: 'loading', providers: [], advertised: [] })
      const [draft, setDraft] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading' }))
        try {
          const result = await rpcCall(ENDPOINTS.list, {})
          if (result?.ok !== true) throw new Error(result?.error?.message ?? t('loadFailed'))
          setState({ status: 'ready', providers: result.value.providers, advertised: result.value.advertised ?? [] })
        } catch (cause) {
          setState({ status: 'error', providers: [], advertised: [] })
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [rpcCall, t])

      useEffect(() => {
        void load()
      }, [load])

      const applySave = useCallback(
        async (limit) => {
          setBusy(true)
          setError('')
          try {
            const result = await rpcCall(ENDPOINTS.save, { limit })
            if (result?.ok !== true) throw new Error(result?.error?.message ?? t('loadFailed'))
            setState((previous) => ({ ...previous, status: 'ready', providers: result.value.providers }))
            setDraft(undefined)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        },
        [rpcCall, t],
      )

      const applyRemove = useCallback(
        async (limit) => {
          setBusy(true)
          setError('')
          try {
            const result = await rpcCall(ENDPOINTS.remove, { provider: limit.provider })
            if (result?.ok !== true) throw new Error(result?.error?.message ?? t('loadFailed'))
            setState((previous) => ({ ...previous, status: 'ready', providers: result.value.providers }))
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        },
        [rpcCall, t],
      )

      // Flipping the switch saves the row unchanged except for `enabled`, so the
      // limit itself never has to be retyped.
      const applyToggle = useCallback(
        async (limit) => {
          setBusy(true)
          setError('')
          try {
            const result = await rpcCall(ENDPOINTS.save, { limit: { ...limit, enabled: !limit.enabled } })
            if (result?.ok !== true) throw new Error(result?.error?.message ?? t('loadFailed'))
            setState((previous) => ({ ...previous, status: 'ready', providers: result.value.providers }))
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        },
        [rpcCall, t],
      )

      const missing = useMemo(() => {
        const present = new Set(state.providers.map((row) => row.provider))
        return state.advertised.filter((provider) => !present.has(provider))
      }, [state.advertised, state.providers])

      return h(
        'div',
        { className: 'dsg-root' },
        h('p', { className: 'dsg-intro' }, t('intro')),
        state.status === 'loading'
          ? h('div', { className: 'dsg-empty' }, t('loading'))
          : state.status === 'error'
            ? h(
                'div',
                { className: 'dsg-empty' },
                h('div', null, error === '' ? t('loadFailed') : error),
                h('button', { type: 'button', className: 'dsg-btn', onClick: () => void load() }, t('retry')),
              )
            : state.providers.length === 0
              ? h('div', { className: 'dsg-empty' }, t('empty'))
              : h(
                  'div',
                  { className: 'dsg-list' },
                  state.providers.map((limit) =>
                    draft !== undefined && draft.provider === limit.provider
                      ? h(LimitForm, {
                          key: limit.provider,
                          initial: limit,
                          t,
                          busy,
                          existing: state.providers,
                          onCancel: () => setDraft(undefined),
                          onSave: applySave,
                        })
                      : h(LimitRow, {
                          key: limit.provider,
                          limit,
                          t,
                          busy,
                          onEdit: setDraft,
                          onRemove: applyRemove,
                          onToggle: applyToggle,
                        }),
                  ),
                ),
        draft !== undefined && !state.providers.some((row) => row.provider === draft.provider)
          ? h(LimitForm, {
              key: '__new__',
              initial: draft.provider === '' ? undefined : draft,
              t,
              busy,
              existing: state.providers,
              onCancel: () => setDraft(undefined),
              onSave: applySave,
            })
          : null,
        state.status === 'ready' && draft === undefined
          ? h(
              'div',
              { className: 'dsg-field' },
              h(
                'div',
                { className: 'dsg-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dsg-btn dsg-btn-primary', disabled: busy, onClick: () => setDraft({ provider: '' }) },
                  t('add'),
                ),
              ),
              missing.length === 0
                ? null
                : h(
                    'div',
                    null,
                    h('span', { className: 'dsg-hint' }, t('emptyAdvertised')),
                    h(
                      'div',
                      { className: 'dsg-suggest' },
                      missing.map((provider) =>
                        h(
                          'button',
                          {
                            key: provider,
                            type: 'button',
                            className: 'dsg-btn',
                            disabled: busy,
                            onClick: () => setDraft({ provider }),
                          },
                          provider,
                        ),
                      ),
                    ),
                  ),
            )
          : null,
        error !== '' && state.status === 'ready' ? h('div', { className: 'dsg-error' }, error) : null,
      )
    }

    // ---- plugin ----------------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => mountStyles(), 'dsh-image-size-guard: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-image-size-guard: locale')
      const t = ctx.locale.bind(NS)
      // One POST per panel action. The Host admits it through the same
      // Host/Origin and browser-session checks as the rest of the API.
      const rpcCall = async (endpoint, payload, signal) => {
        const response = await fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload }),
          ...(signal === undefined ? {} : { signal }),
        })
        if (!response.ok) throw new Error(`The Host answered HTTP ${response.status}.`)
        return await response.json()
      }
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'image-size-guard',
            order: 16,
            locale: NS,
            label: () => t('nav'),
            inject: () => ({ t, rpcCall }),
          },
          ImageSizeGuardSection,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
