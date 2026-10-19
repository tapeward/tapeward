// TAPEWARD shared chrome + config: header, drawer, footer, toast, clipboard, clock, formatting, safe DOM builder.
// Reads /token.json (name, ca, launch_at, pons_token_url, x, telegram, racebook, holder_min). A link whose value is empty stays
// hidden. The ticker is never written in code: [data-symbol] shows token.symbol only when it is set (null before launch).

export const ZERO = '0x0000000000000000000000000000000000000000'
export const EXPLORER = 'https://explorer.chain.robinhood.com'
export const CHAIN_ID = 4663
export const DISCLAIMER = 'Free to enter, no purchase necessary. Prizes are paid from the project\'s prize wallet, funded by 5 % of creator fees; amounts vary and can be zero. Not affiliated with Robinhood, Kalshi or any campaign. Baskets are an editorial reading of market commentary, not a political statement. Stock Tokens are tokenized derivatives tracking a share, not the share itself. 18+. Void where prohibited. Not financial advice.'
export const PRIZE_WALLET = '0xA15C1F4CbF19ea617A0a87cc414F6D0aF62ce2f1'
// dollars for prize amounts: "$12", "$4.20", "$0.35"
// token amounts: 0.00186656 → "0.001867"
export const amt = (v) => (v == null || isNaN(v) ? '' : Number(v) >= 1 ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 }) : Number(Number(v).toPrecision(4)).toString())
export const usd = (v) => (v == null || isNaN(v) ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: v < 100 ? 2 : 0, maximumFractionDigits: v < 100 ? 2 : 0 })}`)

export const token = { name: 'TAPEWARD', symbol: null, ca: ZERO, racebook: '', launch_at: null, domain: 'tapeward.live', x: '', telegram: '', pons_token_url: '', holder_min: 0 }
let loaded = false
const waiters = []
export function onConfig(fn) { waiters.push(fn); if (loaded) fn(token) }

export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '') && String(a).toLowerCase() !== ZERO
export const isLive = () => isAddr(token.ca)
export const txUrl = (h) => `${EXPLORER}/tx/${h}`
export const addrUrl = (a) => `${EXPLORER}/address/${a}`
export const short = (s, n = 4) => (s ? (String(s).length > 2 * n + 4 ? `${String(s).slice(0, 2 + n)}…${String(s).slice(-n)}` : String(s)) : '')

// ── clock: server time when known (state.now), so countdowns agree with the server ─────────────
let skew = 0
export const clock = { now: () => Date.now() + skew, set(serverNow) { const t = Date.parse(serverNow); if (!isNaN(t)) skew = t - Date.now() } }

// ── safe DOM builder: strings become text nodes, never HTML ─────────────────────────────────────
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'html') el.innerHTML = v // own static markup only (icons)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]

// ── numbers / time ─────────────────────────────────────────────────────────────────────────────
const p2 = (v) => String(v).padStart(2, '0')
export const nf = (v, d = 0) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
export const pct = (bp, d = 2) => (bp == null || isNaN(bp) ? '—' : `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${Math.abs(bp / 100).toFixed(d)} %`)
export const bpTxt = (bp) => (bp == null || isNaN(bp) ? '—' : `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${Math.abs(Math.trunc(bp)).toLocaleString('en-US')} bp`)
export const dirClass = (v) => (v == null || isNaN(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat')
export const price = (v) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
export function toDate(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return v
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n) }
  const d = new Date(v); return isNaN(d) ? null : d
}
export function fmtUtc(v, opts = {}) {
  const d = toDate(v); if (!d) return '—'
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
  if (!opts.date) return `${hm} UTC`
  const day = d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
  return `${day} · ${hm} UTC`
}
export function fmtAgo(v) {
  const d = toDate(v); if (!d) return ''
  const s = Math.round((clock.now() - d) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, x = s % 60
  return (d > 0 ? `${d}D ` : '') + `${p2(hh)}:${p2(m)}:${p2(x)}`
}

// ── icons (own markup) ─────────────────────────────────────────────────────────────────────────
export const ICON = {
  x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.7 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.5 4.7H5.7z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.6 4.4 18.4 19.5c-.2 1-.9 1.3-1.8.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.4-.1-.5-.6-.2L6.1 13.2l-4.8-1.5c-1-.3-1-1 .2-1.5L20.2 2.9c.9-.3 1.6.2 1.4 1.5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  // mark: one hex prism, left face RED, right face BLUE, a white tape across
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5 27.7 9.25v13.5L16 29.5 4.3 22.75V9.25z" fill="#121d3f" stroke="#f4f6fb" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 6.2 8 10.8v10.4l8 4.6z" fill="#e0323c"/><path d="M16 6.2l8 4.6v10.4l-8 4.6z" fill="#2f6bff"/><path d="M5.2 15h21.6v3H5.2z" fill="#f4f6fb"/></svg>',
}
export const extArrow = () => h('span', { class: 'ext', 'aria-hidden': 'true', html: ICON.arrow })

// ── toast + clipboard ──────────────────────────────────────────────────────────────────────────
let toastEl, toastT
export function toast(msg, ms = 2600) {
  if (!toastEl) { toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(toastEl) }
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms)
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text })
    ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0'
    document.body.append(ta); ta.select()
    let ok = false; try { ok = document.execCommand('copy') } catch {}
    ta.remove(); return ok
  }
}
export function copyButton(getText, label = 'Copy') {
  const b = h('button', { class: 'copy', type: 'button', 'aria-label': label, title: label, html: ICON.copy })
  b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation()
    const t = getText(); if (!t) return
    if (await copyText(t)) { b.innerHTML = ICON.check; toast('Copied.'); setTimeout(() => (b.innerHTML = ICON.copy), 1400) }
  })
  return b
}

// ── header ─────────────────────────────────────────────────────────────────────────────────────
const LINKS = [['/', 'Live'], ['/board/', 'Board'], ['/docs/', 'Docs']]
function navLinks(cls = '') {
  const here = location.pathname.replace(/index\.html$/, '')
  return LINKS.map(([href, l]) => {
    const cur = href === '/' ? here === '/' : here.startsWith(href)
    return `<a class="${cls}" href="${href}"${cur ? ' aria-current="page"' : ''}>${l}</a>`
  }).join('')
}
function caChip() {
  const chip = h('span', { class: 'chip ca-chip pending', 'data-ca-chip': '' },
    h('span', { class: 'k' }, 'CA'), h('span', { class: 'v', 'data-ca-text': '' }, 'CA at launch'))
  const btn = copyButton(() => (isLive() ? token.ca : ''), 'Copy contract address')
  btn.hidden = true; btn.dataset.caCopy = ''
  chip.append(btn)
  return chip
}
function renderHeader(el) {
  el.classList.add('hdr')
  el.innerHTML = `
    <a class="wordmark" href="/" aria-label="Home"><span class="mk">${ICON.logo}</span><span data-name>TAPEWARD</span></a>
    <nav class="hdr-nav" aria-label="Main">${navLinks()}</nav>
    <span class="hdr-gap"></span>
    <span class="chip t0-chip" data-t0 hidden><span class="k">Launch in</span><b data-t0-v></b></span>`
  el.append(caChip())
  el.insertAdjacentHTML('beforeend', `
    <a class="icon-link" data-link="x" target="_blank" rel="noopener" aria-label="X" hidden>${ICON.x}</a>
    <a class="icon-link" data-link="telegram" target="_blank" rel="noopener" aria-label="Telegram" hidden>${ICON.tg}</a>
    <a class="btn buy" data-buy target="_blank" rel="noopener" hidden>Buy on Pons</a>
    <button class="burger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="drawer">${ICON.menu}</button>`)
  const drawer = h('nav', { class: 'drawer', id: 'drawer', 'aria-label': 'Menu' })
  drawer.innerHTML = `${navLinks('nl')}
    <a class="nl" data-link="x" target="_blank" rel="noopener" hidden>X</a>
    <a class="nl" data-link="telegram" target="_blank" rel="noopener" hidden>Telegram</a>
    <div class="row"><span class="chip t0-chip" data-t0 hidden><span class="k">Launch in</span><b data-t0-v></b></span></div>`
  drawer.querySelector('.row').append(caChip())
  el.after(drawer)
  const burger = el.querySelector('.burger')
  const setOpen = (open) => {
    drawer.classList.toggle('open', open)
    burger.setAttribute('aria-expanded', String(open)); burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
    burger.innerHTML = open ? ICON.close : ICON.menu
  }
  burger.addEventListener('click', () => setOpen(!drawer.classList.contains('open')))
  drawer.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false) })
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) { setOpen(false); burger.focus() } })
}

export function launchAt() { const d = toDate(token.launch_at); return d && !isNaN(d) ? d : null }
function tick() {
  const at = launchAt()
  const ms = at ? at - clock.now() : -1
  $$('[data-t0]').forEach((t) => { t.hidden = !(ms > 0) })
  $$('[data-t0-v]').forEach((t) => { if (ms > 0) t.textContent = fmtDur(ms) })
  $$('[data-countdown-t0]').forEach((e) => { e.textContent = ms > 0 ? fmtDur(ms) : 'live' })
}

// ── footer ─────────────────────────────────────────────────────────────────────────────────────
function renderFooter(el) {
  el.classList.add('ftr')
  el.innerHTML = `<div class="in">
    <a class="wordmark" href="/" aria-label="Home"><span class="mk">${ICON.logo}</span><span data-name>TAPEWARD</span></a>
    <nav aria-label="Footer">${navLinks()}<a href="/docs/#onchain">On chain</a><a href="/docs/#faq">FAQ</a>
      <a data-link="x" target="_blank" rel="noopener" hidden>X</a><a data-link="telegram" target="_blank" rel="noopener" hidden>Telegram</a></nav>
    <p class="legal"></p>
    <p class="meta">Prices: Chainlink feeds on Robinhood Chain (4663) · Reference odds: Kalshi public API · <a href="/docs/#onchain">Contract on Robinhood Chain</a></p>
  </div>`
  el.querySelector('.legal').textContent = DISCLAIMER
}

// ── bindings ───────────────────────────────────────────────────────────────────────────────────
export function applyToken(root = document) {
  $$('[data-link]', root).forEach((a) => {
    const v = token[a.dataset.link]
    if (v) { a.href = v; a.hidden = false } else { a.removeAttribute('href'); a.hidden = true }
  })
  $$('[data-buy]', root).forEach((a) => {
    if (token.pons_token_url) { a.href = token.pons_token_url; a.hidden = false } else { a.removeAttribute('href'); a.hidden = true }
  })
  $$('[data-symbol]', root).forEach((e) => {
    if (token.symbol) { e.textContent = '$' + token.symbol; e.hidden = false } else { e.textContent = ''; e.hidden = true }
  })
  $$('[data-name]', root).forEach((e) => (e.textContent = token.name || 'TAPEWARD'))
  const live = isLive()
  $$('[data-ca-chip]', root).forEach((c) => {
    c.classList.toggle('pending', !live)
    c.querySelector('[data-ca-text]').textContent = live ? short(token.ca, 5) : 'CA at launch'
    c.title = live ? token.ca : 'The contract address is posted here at launch'
    const b = c.querySelector('[data-ca-copy]'); if (b) b.hidden = !live
  })
  $$('[data-ca-full]', root).forEach((e) => (e.textContent = live ? token.ca : 'posted here at launch'))
  $$('[data-racebook]', root).forEach((e) => {
    const a = token.racebook
    if (isAddr(a)) { e.textContent = a; if (e.tagName === 'A') e.href = addrUrl(a); e.closest('[data-racebook-wrap]')?.removeAttribute('hidden') }
  })
  document.documentElement.classList.toggle('token-live', live)
}

export async function loadJson(url) {
  try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return await r.json() } catch {}
  return null
}
async function loadToken() {
  const t = await loadJson('/token.json')
  if (t) Object.assign(token, t)
  loaded = true
  applyToken(); tick()
  waiters.forEach((fn) => { try { fn(token) } catch (e) { console.error(e) } })
}

function boot() {
  const hd = document.getElementById('hdr'); if (hd) renderHeader(hd)
  const ft = document.getElementById('ftr'); if (ft) renderFooter(ft)
  applyToken()
  loadToken()
  setInterval(tick, 1000)
  // token.json flips at go-live without a reload
  setInterval(async () => {
    const t = await loadJson('/token.json')
    if (t && (t.ca !== token.ca || t.symbol !== token.symbol || t.pons_token_url !== token.pons_token_url || t.x !== token.x || t.telegram !== token.telegram || t.racebook !== token.racebook)) {
      Object.assign(token, t); applyToken(); tick(); waiters.forEach((fn) => { try { fn(token) } catch {} })
    }
  }, 60000)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
