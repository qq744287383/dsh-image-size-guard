/**
 * Render a standalone preview of the Turn-tail notice.
 *
 * The CSS is read out of the shipped client bundle, so the preview always shows
 * the real box model, spacing, and typography. The `--dsw-alias-*` values are
 * the Harness theme's, and no page outside the app supplies them, so the preview
 * defines neutral fallbacks: the colors here approximate the app, the geometry
 * does not.
 *
 * Usage: node scripts/preview-turn-notice.mjs
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = await readFile(new URL('client/client.js', root), 'utf8')

const css = source.match(/const CSS = `([\s\S]*?)`\n/)?.[1]
if (css === undefined) throw new Error('client/client.js no longer declares a CSS template literal')

/** One rendered notice, as the component builds it. */
function notice({ source, text, stamp }) {
  return `<div class="dsg-turnoff" title="涉及消息 3 · 23:41 · 图片仍在会话里，只是模型收到的是路径占位">`
    + '<span class="dsg-turnoff-mark" aria-hidden="true">⤿</span>'
    + `<span class="dsg-turnoff-source">${source}</span>`
    + `<span class="dsg-turnoff-text">${text}</span>`
    + (stamp === undefined ? '' : `<span class="dsg-turnoff-time">${stamp}</span>`)
    + '</div>'
}

const samples = [
  { label: '今天', notice: notice({ source: '图片体积守卫', text: '本轮请求超出预算，3 张历史图片改为占位文本发送', stamp: '23:41' }) },
  { label: '往期', notice: notice({ source: '图片体积守卫', text: '本轮请求超出预算，6 张历史图片改为占位文本发送', stamp: '11-3 09:12' }) },
  { label: 'English', notice: notice({ source: 'Image size guard', text: '2 history image(s) went out as placeholder text for this request', stamp: '23:41' }) },
  { label: '窄列宽（文字截断）', notice: notice({ source: '图片体积守卫', text: '本轮请求超出预算，6 张历史图片改为占位文本发送', stamp: '11-3 09:12' }), narrow: true },
  { label: '无时间（时间不可用）', notice: notice({ source: '图片体积守卫', text: '本轮请求超出预算，1 张历史图片改为占位文本发送' }) },
]

const page = `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>图片体积守卫 · 轮次提示预览</title>
<style>
  :root {
    color-scheme: light dark;
    /* Fallbacks only: the app supplies these from its theme. */
    --light-bg-base: #ffffff; --light-bg-layer-1: #ffffff; --light-bg-layer-2: #f4f5f7;
    --light-border-l1: #e4e6ea; --light-label-primary: #16181d; --light-label-secondary: #6b7280;
    --light-warn: #b45309;
    --dark-bg-base: #17181b; --dark-bg-layer-1: #17181b; --dark-bg-layer-2: #24262b;
    --dark-border-l1: #34373d; --dark-label-primary: #eceef2; --dark-label-secondary: #9aa0aa;
    --dark-warn: #e0a355;
  }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  section { padding: 24px 28px 32px; }
  section.light { background: var(--light-bg-base); color: var(--light-label-primary); }
  section.dark { background: var(--dark-bg-base); color: var(--dark-label-primary); }
  section.light { --dsw-alias-bg-base: var(--light-bg-base); --dsw-alias-bg-layer-1: var(--light-bg-layer-1); --dsw-alias-bg-layer-2: var(--light-bg-layer-2); --dsw-alias-border-l1: var(--light-border-l1); --dsw-alias-border-l2: var(--light-border-l1); --dsw-alias-label-primary: var(--light-label-primary); --dsw-alias-label-secondary: var(--light-label-secondary); --dsw-alias-state-warn-primary: var(--light-warn); --dsw-alias-brand-primary: #2563eb; --dsw-alias-state-error-primary: #b91c1c; --dsw-alias-state-success-primary: #15803d; }
  section.dark { --dsw-alias-bg-base: var(--dark-bg-base); --dsw-alias-bg-layer-1: var(--dark-bg-layer-1); --dsw-alias-bg-layer-2: var(--dark-bg-layer-2); --dsw-alias-border-l1: var(--dark-border-l1); --dsw-alias-border-l2: var(--dark-border-l1); --dsw-alias-label-primary: var(--dark-label-primary); --dsw-alias-label-secondary: var(--dark-label-secondary); --dsw-alias-state-warn-primary: var(--dark-warn); --dsw-alias-brand-primary: #6ea8fe; --dsw-alias-state-error-primary: #f87171; --dsw-alias-state-success-primary: #4ade80; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p.hint { margin: 0 0 20px; font-size: 12px; opacity: .7; }
  .sample { margin: 0 0 18px; }
  .sample > .label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; opacity: .55; margin-bottom: 6px; }
  .sample.narrow .bubble { max-width: 300px; }
  .bubble { padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
${css}
</style>
<section class="light">
  <h1>轮次提示 · 浅色</h1>
  <p class="hint">真实间距与排版；颜色为本页回退值，应用内由 Harness 主题提供。</p>
  ${samples.map((sample) => `<div class="sample${sample.narrow === true ? ' narrow' : ''}"><div class="label">${sample.label}</div><div class="bubble">${sample.notice}</div></div>`).join('\n  ')}
</section>
<section class="dark">
  <h1>轮次提示 · 深色</h1>
  <p class="hint">真实间距与排版；颜色为本页回退值，应用内由 Harness 主题提供。</p>
  ${samples.map((sample) => `<div class="sample"><div class="label">${sample.label}</div><div class="bubble">${sample.notice}</div></div>`).join('\n  ')}
</section>
`

await mkdir(new URL('preview/', root), { recursive: true })
await writeFile(new URL('preview/turn-notice.html', root), page)
console.log('preview/turn-notice.html')
