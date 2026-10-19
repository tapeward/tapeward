// Broadcast screen: scoreboard, studio map, lower-third, ticker tape, countdowns. Everything shown comes from /api/state.
import { $, $$, h, clock, toDate, fmtUtc, fmtAgo, fmtDur, pct, bpTxt, dirClass, price, short, txUrl, addrUrl, usd as money, DISCLAIMER, PRIZE_WALLET } from '/shared/site.js'
import { subscribeState, pickRounds, roundStatus, FIXTURE, prizeInfo, loadPrizeInfo } from '/shared/api.js'
import { NAMES, LAYOUT, hexXZ } from './hexgrid.js'
import { initPanel } from './panel.js'

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const mobile = matchMedia('(max-width: 980px), (pointer: coarse)').matches
let state = null
let map = null
let pinned = null // state code pinned by click/tap/keyboard

// ── map (WebGL, with a flat fallback) ─────────────────────────────────────────────────────────
const canvas = $('#map'), labels = $('#labels')
async function startMap() {
  try {
    const probe = document.createElement('canvas')
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('no webgl')
    const { createMap } = await import('./map3d.js')
    map = createMap({ canvas, labels, reduced, mobile, onHover: (st) => showRace(st), onSelect: (st) => { pinned = st; showRace(st) } })
    if (state?.kalshi) map.setData(state.kalshi.states)
  } catch (e) {
    console.info("map fallback", e?.message)
    flatMap()
  }
}
let leanCss = null
async function flatMap() {
  // no WebGL: a flat CSS hex grid over the key visual, same layout and colours
  document.querySelector('.stage').classList.add('flat')
  canvas.hidden = true
  const { leanCss: lc } = await import('./map3d.js').catch(() => ({}))
  leanCss = lc || (() => '#4a5578')
  const box = h('div', { class: 'flat-map', role: 'list' })
  for (const st of Object.keys(LAYOUT)) {
    const [x, z] = hexXZ(st)
    const b = h('button', { class: 'fh', type: 'button', role: 'listitem', 'data-st': st, style: `left:${(x / 20.8) * 100}%;top:${(z / 12.5) * 100}%`, onclick: () => { pinned = pinned === st ? null : st; showRace(pinned) } }, st)
    box.append(b)
  }
  labels.replaceWith(box)
  map = {
    setData(states) { $$('.fh', box).forEach((b) => { const r = states?.[b.dataset.st]; b.style.background = r ? leanCss(r.pD) : '#2a3354'; b.classList.toggle('called', !!r?.result) }) },
    hover() {}, select(st) { pinned = st; showRace(st) }, focusNext() { return null },
  }
  if (state?.kalshi) map.setData(state.kalshi.states)
}
canvas.addEventListener('keydown', (e) => {
  if (!map) return
  if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); pinned = map.focusNext(1) }
  else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); pinned = map.focusNext(-1) }
  else if (e.key === 'Escape') { map.select(null); pinned = null; showRace(null) }
})

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
const set = (sel, txt) => $$(sel).forEach((e) => (e.textContent = txt))
const dayLabel = (id) => {
  const m = /^D-(\d{4}-\d{2}-\d{2})$/.exec(id || ''); if (!m) return id || ''
  return new Date(m[1] + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
}
const pctOf = (p) => `${Math.round(p * 100)}`
const leader = (pD) => (pD == null ? '—' : pD >= 0.5 ? `D ${pctOf(pD)} %` : `R ${pctOf(1 - pD)} %`)
const usd = (v) => (v == null ? null : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`)
const raceName = (r) => (r === 'gov' || r === 'governor' ? 'Governor' : 'Senate')

// ── scoreboard ────────────────────────────────────────────────────────────────────────────────
function renderScoreboard() {
  const s = state; if (!s) return
  const { election, openDaily, liveDaily, lastDaily } = pickRounds(s)
  const race = s.race
  const raceRound = race?.roundId ? s.rounds.find((r) => r.id === race.roundId) : null
  const official = raceRound?.results?.[0]
  const red = official?.redBp ?? race?.red?.bp, blue = official?.blueBp ?? race?.blue?.bp, ref = official?.refBp ?? race?.ref?.bp
  const spread = official?.spreadBp ?? race?.spreadBp ?? (red != null && blue != null ? red - blue : null)

  $('[data-live]').hidden = !s.market.open
  $('[data-fixture]').hidden = !s.fixture
  const sessionOnly = !raceRound && race && race.red?.bp != null
  const sinceDay = race?.since ? race.since.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }) : ''
  // a daily round open for picks (and nothing racing yet) leads the header; last session's numbers stay below as "last session"
  const todayId = `D-${new Date(clock.now()).toISOString().slice(0, 10)}`
  const upNext = !raceRound && openDaily ? openDaily : null
  const upLabel = upNext ? (upNext.id === todayId ? "Today's round" : 'Next round') : ''
  set('[data-show]', raceRound ? (raceRound.kind === 'election' ? 'RED vs BLUE · Election Night' : `RED vs BLUE · Daily round · ${dayLabel(raceRound.id)}`) : upNext ? `${upLabel} · ${dayLabel(upNext.id)}` : sessionOnly ? `RED vs BLUE · Last session · ${sinceDay}` : 'RED vs BLUE')
  let sub = ''
  if (upNext) sub = `picks close ${fmtUtc(upNext.picksClose)} · locks at the open${upNext.lock ? ` (${fmtUtc(upNext.lock)})` : ''}`
  else if (official) sub = 'official · scored from Chainlink prices on Robinhood Chain'
  else if (raceRound && s.market.open) sub = `since the ${fmtUtc(raceRound.lock)} lock · live, unofficial`
  else if (raceRound) sub = 'at the close · unofficial until settled'
  else if (sessionOnly) sub = `open → close, no round · unofficial${s.market.nextOpen ? ` · market opens ${fmtUtc(s.market.nextOpen, { date: true })}` : ''}`
  else sub = s.market.nextOpen ? `market opens ${fmtUtc(s.market.nextOpen, { date: true })}` : ''
  set('[data-show-sub]', sub)

  $$('[data-bp]').forEach((e) => { const v = e.dataset.bp === 'red' ? red : blue; e.textContent = v == null ? '—' : pct(v) })
  set('[data-bp-k]', official ? 'settled' : race?.roundId ? (s.market.open ? 'live' : 'at close') : sessionOnly ? `last session · ${sinceDay}` : 'no race yet')
  set('[data-spread]', spread == null ? '—' : bpTxt(spread).toUpperCase())
  const lead = $('[data-lead]')
  lead.textContent = spread == null ? (s.market.nextOpen ? 'Waiting for the open' : '—') : spread > 0 ? 'RED leads' : spread < 0 ? 'BLUE leads' : 'Level'
  const tug = Math.max(-300, Math.min(300, spread || 0))
  $('[data-tug]').style.width = `${50 + (tug / 300) * 50}%`
  set('[data-ref]', ref == null ? '—' : pct(ref))
  const note = $('[data-race-note]')
  note.textContent = ''
  if (official?.tx) note.append('Scored from Chainlink prices on Robinhood Chain · settle tx ', h('a', { href: txUrl(official.tx), target: '_blank', rel: 'noopener' }, short(official.tx)))
  else note.textContent = 'Equal-weight baskets · Chainlink prices on Robinhood Chain'

  // counters line: the open daily round first, then Election Night (SERVER rounds[].counters:
  // {picks, wallets, anchoredLeaves, pending, lastAnchor{tx, link}}); after the Election lock, its race since lock
  const el = $('[data-el-line]')
  const n = (v, w) => `${v ?? 0} ${w}${v === 1 ? '' : 's'}`
  const counterBits = (r, label) => {
    const c = r.raw?.counters || {}
    const la = c.lastAnchor || r.anchors[r.anchors.length - 1]
    const out = [h('b', null, label), ` ${n(c.picks ?? r.picks, 'pick')} · ${n(c.wallets ?? r.wallets, 'wallet')}`]
    if (la?.tx) out.push(` · ${c.anchoredLeaves ?? la.count ?? 0} on Robinhood Chain (`, la.link || !String(la.tx).startsWith('mock') ? h('a', { href: la.link || txUrl(la.tx), target: '_blank', rel: 'noopener', title: 'Latest on-chain record of this round' }, short(la.tx)) : short(la.tx), ')')
    if (c.pending) out.push(` · ${c.pending} recording`)
    return h('span', { class: 'cnt' }, out)
  }
  el.textContent = ''
  const dailyForCount = raceRound?.kind === 'daily' ? raceRound : openDaily
  if (dailyForCount) el.append(counterBits(dailyForCount, dayLabel(dailyForCount.id)))
  if (election) {
    const st = roundStatus(election)
    const er = s.electionRace
    if (er && er.red.bp != null && ['locked', 'settling', 'scored'].includes(st)) {
      el.append(h('span', { class: 'cnt' }, h('b', null, 'Election Night since lock '), h('span', { class: 'side red' }, pct(er.red.bp)), ' ', h('span', { class: 'side blue' }, pct(er.blue.bp)), ` · spread ${bpTxt(er.spreadBp ?? er.red.bp - er.blue.bp)}`))
    } else el.append(counterBits(election, 'Election Night'))
  }
  el.hidden = !el.childNodes.length
  // the generic note gives way when the counters need the room
  if (!official?.tx && el.childNodes.length > 1) note.textContent = ''

  // control odds
  const ctl = s.kalshi?.control || {}
  for (const k of ['house', 'senate']) {
    const e = $(`[data-ctl="${k}"]`)
    const pD = ctl[k]?.pD
    e.textContent = pD == null ? '—' : leader(pD)
  }
  $('[data-read]').hidden = !s.kalshi
  countdowns()
}

// countdown chips: Election Night lock (→ scores), market open while there's no race
function countdowns() {
  const s = state; if (!s) return
  const now = clock.now()
  const { election } = pickRounds(s)
  const k = $('[data-cd-el-k]'), v = $('[data-cd-el-v]')
  if (election) {
    const st = roundStatus(election, now)
    if (st === 'open' || st === 'upcoming' || st === 'closed') { k.textContent = 'Election Night lock in'; v.textContent = fmtDur(election.lock - now) }
    else {
      const next = election.scoreTimes.findIndex((t) => t > now)
      if (next >= 0) { k.textContent = `${election.scoreLabels[next] || 'Score'} scores in`; v.textContent = fmtDur(election.scoreTimes[next] - now) }
      else { k.textContent = 'Election Night'; v.textContent = 'scored' }
    }
  } else { k.textContent = 'Election Night'; v.textContent = 'locks 3 Nov 21:00 UTC' }
  const lead = $('[data-lead]')
  if (s.race?.spreadBp == null && s.race?.red?.bp == null && s.market.nextOpen && s.market.nextOpen > now) lead.textContent = `Open in ${fmtDur(s.market.nextOpen - now)}`
  panel?.tick()
}

// ── prizes ────────────────────────────────────────────────────────────────────────────────────
function prizeRounds() {
  const { election, openDaily, liveDaily } = pickRounds(state)
  const today = liveDaily || openDaily
  const todayId = `D-${new Date(clock.now()).toISOString().slice(0, 10)}`
  return { today, election, todayLabel: !today || today.id === todayId ? "Today's prize" : `Prize · ${dayLabel(today.id)}` }
}
const prizeText = (p, k) => (p.none ? (k === 'today' ? 'No prize today' : 'No prize') : `${p.estimate ? '≈ ' : ''}${money(p.usd)}`)
function renderPrizes() {
  const box = $('[data-prize]'); if (!state || !box) return
  const { today, election, todayLabel } = prizeRounds()
  let any = false
  for (const [k, r] of [['today', today], ['election', election]]) {
    const el = $(`[data-pz="${k}"]`), p = r?.prize
    if (!p || (p.usd == null && !p.none)) { el.hidden = true; continue }
    any = true; el.hidden = false
    el.classList.toggle('none', p.none)
    if (k === 'today') el.querySelector('.pz-k').textContent = todayLabel
    el.querySelector('.pz-v').textContent = prizeText(p, k)
    el.querySelector('.pz-t').textContent = p.none ? 'prize wallet too small for a daily prize' : `top ${p.top} · ${p.locked ? 'set at the lock' : 'estimate until the lock'} · paid after ${p.paidAfter === 'Day one' ? 'the Day one result' : 'the close'}`
  }
  const w = PRIZE_WALLET
  const pin = box.querySelector('[data-pz-in]'); if (pin) pin.textContent = prizeInfo.paidIn ? ` in ${prizeInfo.paidIn}` : ''
  const a = box.querySelector('[data-pz-wallet]'); a.href = addrUrl(w); a.title = w
  box.hidden = !any
}

// ── tape ──────────────────────────────────────────────────────────────────────────────────────
function renderTape() {
  const s = state; const run = $('[data-tape]'); if (!s?.race) { run.textContent = ''; return }
  const feeds = [...s.race.red.feeds, ...s.race.blue.feeds, ...s.race.ref.feeds]
  if (!feeds.length) return
  const item = (f) => {
    const tip = [f.name, f.roundId ? `Chainlink round ${f.roundId}` : null, f.updatedAt ? `updated ${fmtUtc(f.updatedAt, { date: true })}` : null, f.startPrice ? `start ${price(f.startPrice)}` : null].filter(Boolean).join(' · ')
    const a = h(f.proxy ? 'a' : 'span', { class: `tp ${String(f.basket).toLowerCase()}`, title: tip, href: f.proxy ? addrUrl(f.proxy) : null, target: f.proxy ? '_blank' : null, rel: f.proxy ? 'noopener' : null },
      h('i', { class: 'sq', 'aria-hidden': 'true' }), h('b', null, f.symbol), h('span', { class: 'px' }, price(f.price)),
      h('span', { class: `ch ${dirClass(f.bp)}` }, f.bp == null ? '' : pct(f.bp)),
      f.roundId ? h('span', { class: 'rid' }, `#${short(f.roundId, 3)}`) : null)
    return a
  }
  const list = feeds.map(item)
  run.textContent = ''
  const g1 = h('div', { class: 'tape-g' }, list)
  run.append(g1)
  if (!reduced) {
    const g2 = h('div', { class: 'tape-g', 'aria-hidden': 'true' }, feeds.map(item))
    g2.querySelectorAll('a').forEach((a) => a.setAttribute('tabindex', '-1'))
    run.append(g2)
    run.style.animationDuration = `${Math.max(30, feeds.length * 4.2)}s`
  }
}

// ── lower third ───────────────────────────────────────────────────────────────────────────────
const L3 = { k: $('[data-l3-k]'), h: $('[data-l3-h]'), s: $('[data-l3-s]'), box: $('.l3') }
function l3(k, head, sub, cls = '') {
  L3.box.className = `l3 ${cls}`
  L3.k.textContent = k; L3.h.textContent = head
  L3.s.textContent = ''
  for (const part of [].concat(sub)) if (part != null) L3.s.append(part)
  if (!reduced) { L3.box.classList.remove('in'); void L3.box.offsetWidth; L3.box.classList.add('in') }
}
function showRace(st) {
  if (!st) { pinned = null; rotate(true); return }
  stopRotate()
  const row = state?.kalshi?.states?.[st]
  const name = NAMES[st] || st
  if (!row) { l3('No race', name, `No Senate or governor race with reference odds in 2026 · source: Kalshi public API`, 'none'); return }
  const cls = row.result ? 'called' : row.pD >= 0.5 ? 'dlean' : 'rlean'
  const others = (row.all || []).filter((r) => r !== row && r.race !== row.race)
  const dP = Math.round(row.pD * 100)
  const head = `${name} · D ${dP} % · R ${100 - dP} %`
  const sub = [
    row.result ? `CALLED: ${String(row.result).toUpperCase().startsWith('D') ? 'Democratic' : 'Republican'} party (market resolved) · ` : '',
    row.vol != null ? `${usd(row.vol)} volume · ` : '',
    'source: Kalshi public API', state?.kalshi?.ts ? ` · ${fmtAgo(state.kalshi.ts)}` : '',
    others.length ? ` · ${others.map((o) => `${raceName(o.race)}: ${leader(o.pD)}`).join(' · ')}` : '',
  ]
  l3(`${raceName(row.race)} · reference odds`, head, sub, cls)
}
function captions() {
  const s = state, out = []; if (!s) return out
  const { election, openDaily } = pickRounds(s)
  // 1. the race
  const r = s.race
  if (r && r.spreadBp != null) {
    const who = r.spreadBp > 0 ? 'RED leads BLUE' : r.spreadBp < 0 ? 'BLUE leads RED' : 'RED and BLUE level'
    const rr = r.roundId ? s.rounds.find((x) => x.id === r.roundId) : null
    out.push([rr ? 'The race' : 'Last session', `${who}${r.spreadBp ? ` by ${Math.abs(r.spreadBp)} bp` : ''}`, `RED ${pct(r.red.bp)} · BLUE ${pct(r.blue.bp)} · SPY ${pct(r.ref.bp)} · ${rr ? (s.market.open ? 'live, unofficial' : 'unofficial until settled on chain') : 'open to close, no round: unofficial'}`])
  }
  // 2. biggest basket mover
  const feeds = r ? [...r.red.feeds, ...r.blue.feeds].filter((f) => f.bp != null) : []
  if (feeds.length) {
    const f = feeds.reduce((a, b) => (Math.abs(b.bp) > Math.abs(a.bp) ? b : a))
    out.push(['Biggest mover', `${f.symbol} ${f.bp >= 0 ? '▲' : '▼'} ${pct(Math.abs(f.bp)).replace('+', '')} · ${f.basket} basket`, [`${f.name || f.symbol} · `, f.roundId ? `Chainlink round ${f.roundId}` : 'Chainlink', f.updatedAt ? ` · updated ${fmtUtc(f.updatedAt)}` : '']])
  }
  // 3. closest Senate races
  const sen = Object.values(s.kalshi?.states || {}).filter((x) => x.race === 'senate' && x.pD != null && !x.result).sort((a, b) => Math.abs(a.pD - 0.5) - Math.abs(b.pD - 0.5)).slice(0, 3)
  if (sen.length) out.push(['Closest Senate races', sen.map((x) => { const m = Math.round(Math.max(x.pD, 1 - x.pD) * 100); return `${x.st} ${m}–${100 - m}` }).join(' · '), ['Reference odds, leading party first · Kalshi public API', s.kalshi.ts ? ` · ${fmtAgo(s.kalshi.ts)}` : '']])
  // 4. called races
  const called = Object.values(s.kalshi?.states || {}).filter((x) => x.result)
  if (called.length) out.push(['Called', `${called.length} race${called.length > 1 ? 's' : ''} called by the market`, called.slice(0, 8).map((x) => `${x.st} ${String(x.result).toUpperCase().slice(0, 1)}`).join(' · ') + ' · Kalshi markets resolved'])
  // 5. picks recorded on chain
  const la = s.lastAnchor || [...s.rounds.flatMap((x) => x.anchors.map((a) => ({ ...a, round: x.id })))].sort((a, b) => (b.at || 0) - (a.at || 0))[0]
  const total = s.counts?.picks ?? s.rounds.reduce((n, x) => n + (x.picks || 0), 0)
  const pl = (n) => `${n} pick${n === 1 ? '' : 's'}`
  if (la?.tx) out.push(['On chain', `${pl(total ?? 0)} recorded on Robinhood Chain`, ['Latest record ', h('a', { href: txUrl(la.tx), target: '_blank', rel: 'noopener' }, `tx ${short(la.tx)}`), la.at ? ` · ${fmtUtc(la.at, { date: true })}` : '', la.round ? ` · ${la.round}` : '']])
  else if (total) out.push(['Picks', `${pl(total)} signed`, 'Recording on Robinhood Chain before the lock'])
  // prizes
  const pr = prizeRounds()
  const tp = pr.today?.prize, ep = pr.election?.prize
  if ((tp && (tp.usd != null || tp.none)) || (ep && ep.usd != null)) {
    const head = tp && (tp.usd != null || tp.none) ? `${pr.todayLabel}: ${prizeText(tp, 'today')}${tp.none ? '' : ` · top ${tp.top}`}` : `Election Night prize: ${prizeText(ep, 'election')} · top ${ep.top}`
    const sub = [ep && ep.usd != null && tp ? `Election Night ${prizeText(ep, 'election')} · top ${ep.top} · ` : '', `Free to play · paid in ${prizeInfo.paidIn || 'stock tokens or ETH'} from the `, h('a', { href: addrUrl(PRIZE_WALLET), target: '_blank', rel: 'noopener' }, 'prize wallet'), ', funded by 5 % of creator fees']
    out.push(['Prizes', head, sub])
  }
  // 6. house desk
  const d = s.desk, hp = (openDaily || election)?.house
  if (d && hp) {
    const rec = d.record || {}
    out.push(['The house desk', `${d.name || 'TAPEWARD desk'} calls ${hp.side} ${pct(Math.abs(hp.spreadBp || 0))}`, `${(openDaily || election).id} · RED or BLUE by the last 5 sessions · record ${rec.right ?? 0} right, ${rec.missed ?? 0} missed`])
  }
  // 7. next lock
  if (openDaily) out.push(['Next lock', `${openDaily.id}: picks close ${fmtUtc(openDaily.picksClose, { date: true })}`, `${pl(openDaily.picks ?? 0)} so far · lock ${fmtUtc(openDaily.lock)} at the market open · free signature, no gas`])
  return out
}
let rotT = null, rotI = 0
function stopRotate() { clearInterval(rotT); rotT = null }
function rotate(now) {
  if (pinned) return
  stopRotate()
  const step = () => { const c = captions(); if (!c.length) return; const [k, hd, sb] = c[rotI++ % c.length]; l3(k, hd, sb) }
  if (now) step()
  rotT = setInterval(step, 7000)
}

// ── wiring ────────────────────────────────────────────────────────────────────────────────────
let panel = null
function onState(s, err) {
  if (!s) { if (!state) l3('Off air', 'Feed unavailable', `Could not reach the state feed${err ? ` (${err.message})` : ''}. Retrying.`); return }
  const first = !state
  state = s
  renderScoreboard()
  renderTape()
  renderPrizes()
  map?.setData(s.kalshi?.states || {})
  panel?.update(s)
  if (first) rotate(true)
}
$('[data-legal]').textContent = DISCLAIMER
// mobile: the lower third sits under the map instead of over it
const narrow = matchMedia('(max-width: 980px), (max-height: 599px)')
const placeL3 = () => {
  const st = $('.stage'), el = $('.l3'), pz = $('[data-prize]')
  if (narrow.matches) { st.after(el); st.after(pz) } else { st.querySelector('.call-open').before(el); st.querySelector('.call-open').after(pz) }
}
narrow.addEventListener('change', placeL3); placeL3()
panel = initPanel({ getState: () => state, reduced })
startMap()
subscribeState(onState)
const refreshPrizes = () => loadPrizeInfo().then(() => { renderPrizes(); panel?.update() })
refreshPrizes(); setInterval(refreshPrizes, 5 * 60e3)
setInterval(countdowns, 1000)
if (FIXTURE) document.title = `[fixture] ${document.title}`
