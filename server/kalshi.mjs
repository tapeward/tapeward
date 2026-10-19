// Public Kalshi reference odds (no key). Polled from the server every 90 s (the API is blocked on the lead's Mac):
//   base https://api.elections.kalshi.com/trade-api/v2 · GET /events/{ticker}?with_nested_markets=true
//   control: CONTROLH-2026, CONTROLS-2026 · per state: SENATE{ST}-26, SENATE{ST}S-26 (special), GOVPARTY{ST}-26
// Discovery (which tickers exist) runs at start and every 6 h; 404 = no such race. Prices are dollar strings
// (yes_bid_dollars / yes_ask_dollars / last_price_dollars). Normalised to
//   { st, race: senate|gov, special, pD, pR, pO, vol, status, result, event, title, others }
// pD/pR/pO are shares of the summed market probabilities (so they add to 1). Every hour the canonical snapshot JSON
// (sorted keys, no whitespace) is hashed with sha256 → RaceBook.postSnapshot(hash, ts, uri); the exact bytes are served at
// /api/snapshot/:hash. Reference odds are information only: they never feed a score.
// Env: KALSHI=live (default) | fixtures (server/fixtures/kalshi/events/*.json) | off · KALSHI_BASE
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SERVER_DIR } from './config.mjs'

export const BASE = process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2'
export const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']
export const CONTROL = { house: 'CONTROLH-2026', senate: 'CONTROLS-2026' }
export const FIXTURE_DIR = SERVER_DIR + 'fixtures/kalshi/'
export const candidates = () => [...Object.values(CONTROL), ...STATES.flatMap((st) => [`SENATE${st}-26`, `SENATE${st}S-26`, `GOVPARTY${st}-26`])]

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null }
const r4 = (x) => Math.round(x * 10_000) / 10_000

/** probability of one binary market (settled → 1/0; tight book → mid; else last trade) */
export function marketProb(m) {
  if (m.result === 'yes') return 1
  if (m.result === 'no') return 0
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars)
  if (bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid && ask - bid <= 0.1) return (bid + ask) / 2
  if (last != null && last > 0) return last
  if (bid != null && ask != null && ask > 0) return (bid + ask) / 2
  return 0
}
const partyOf = (m) => {
  const suf = String(m.ticker || '').split('-').pop()
  return suf === 'D' ? 'D' : suf === 'R' ? 'R' : 'O'
}

/** one Kalshi event (with nested markets) → normalised race, or null when it has no markets */
export function normaliseEvent(ev) {
  const e = ev?.event || ev
  const markets = e?.markets || ev?.markets || []
  if (!markets.length) return null
  const t = String(e.event_ticker || markets[0].event_ticker)
  let raw = { D: 0, R: 0, O: 0 }, vol = 0, result = null
  const others = []
  for (const m of markets) {
    const p = marketProb(m), party = partyOf(m)
    raw[party] += p
    vol += num(m.volume_fp) ?? num(m.volume) ?? 0
    if (party === 'O') others.push({ name: m.yes_sub_title || m.ticker, p: r4(p) })
    if (m.result === 'yes') result = party
  }
  const total = raw.D + raw.R + raw.O || 1
  const statuses = markets.map((m) => m.status)
  const status = statuses.includes('active') ? 'active' : statuses.includes('open') ? 'active' : statuses[0] || 'unknown'
  const m = /^(SENATE|GOVPARTY|CONTROL)([A-Z]{2})?(S)?-/.exec(t)
  const race = m?.[1] === 'SENATE' ? 'senate' : m?.[1] === 'GOVPARTY' ? 'gov' : 'control'
  return {
    st: race === 'control' ? null : m?.[2] || null, race, special: race === 'senate' && m?.[3] === 'S',
    pD: r4(raw.D / total), pR: r4(raw.R / total), pO: r4(raw.O / total), vol: Math.round(vol),
    status, result, event: t, title: e.title || markets[0].title || t, others,
  }
}

/** canonical JSON (sorted keys, no whitespace) */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
export const sha256Hex = (s) => '0x' + createHash('sha256').update(s).digest('hex')

/** events {ticker: eventJson} → snapshot {format, ts, source, control, states} */
export function buildSnapshot(events, tsS) {
  const races = Object.values(events).map(normaliseEvent).filter(Boolean)
  const ctl = (k) => { const r = races.find((x) => x.event === CONTROL[k]); return r ? { pD: r.pD, pR: r.pR, vol: r.vol, status: r.status, result: r.result } : null }
  const states = races.filter((r) => r.race !== 'control').sort((a, b) => (a.st < b.st ? -1 : a.st > b.st ? 1 : a.race < b.race ? 1 : a.race > b.race ? -1 : 0))
  // the hex map shows the Senate race (regular before special), else the governor race
  const seen = new Set()
  for (const r of [...states].sort((a, b) => (a.race === b.race ? Number(a.special) - Number(b.special) : a.race === 'senate' ? -1 : 1))) {
    r.map = !seen.has(r.st); seen.add(r.st)
  }
  return { format: 'tapeward-kalshi/1', ts: tsS, source: `Kalshi public API (${BASE})`, control: { house: ctl('house'), senate: ctl('senate') }, states }
}

export function createKalshi({ store, clock, bus, mode = process.env.KALSHI || 'live', fetchImpl = globalThis.fetch, log = console, fixtureDir = FIXTURE_DIR }) {
  let known = null, discoveredAt = 0, last = { at: null, ok: null, error: null, events: 0 }
  let current = store.kv('kalshi:current') || null   // {snapshot, json, hash}

  async function getEvent(t) {
    if (mode === 'fixtures') {
      const f = `${fixtureDir}events/${t}.json`
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
    }
    const r = await fetchImpl(`${BASE}/events/${t}?with_nested_markets=true`, { headers: { accept: 'application/json', 'user-agent': 'tapeward-server/1.0 (+https://tapeward.live)' }, signal: AbortSignal.timeout(15_000) })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`kalshi ${t}: HTTP ${r.status}`)
    return r.json()
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
    return out
  }

  async function poll() {
    if (mode === 'off') return null
    const now = clock()
    try {
      if (mode === 'fixtures' && !known) known = readdirSync(fixtureDir + 'events').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
      const discover = !known || now - discoveredAt > 6 * 3_600_000
      const list = discover ? candidates() : known
      const got = await pool(list, 4, async (t) => { try { return [t, await getEvent(t)] } catch (e) { return [t, e] } })
      const events = {}, errors = []
      for (const [t, v] of got) { if (v instanceof Error) errors.push(t); else if (v) events[t] = v }
      if (discover) { known = Object.keys(events); discoveredAt = now }
      if (!Object.keys(events).length) throw new Error(errors.length ? `no event answered (${errors.length} errors)` : 'no events')
      const snapshot = buildSnapshot(events, Math.floor(now / 1000))
      const json = canonical(snapshot)
      current = { snapshot, json, hash: sha256Hex(json) }
      store.setKv('kalshi:current', current)
      last = { at: now, ok: true, error: errors.length ? `${errors.length} events failed` : null, events: Object.keys(events).length }
      bus?.emit('kalshi', current)
      return current
    } catch (e) {
      last = { at: now, ok: false, error: e.message, events: 0 }
      log.error?.(`kalshi: ${e.message}`)
      return null
    }
  }

  /** store the current snapshot by hash (hourly; the hash is what goes on chain) */
  function freeze() {
    if (!current) return null
    store.putSnapshot({ hash: current.hash, ts: current.snapshot.ts, json: current.json })
    return { hash: current.hash, ts: current.snapshot.ts }
  }

  /** compact view for /api/state */
  function view() {
    if (!current) return { ts: null, hash: null, source: 'Kalshi public API', control: { house: null, senate: null }, states: [] }
    const s = current.snapshot
    const posted = store.lastSnapshotPost()
    return {
      ts: new Date(s.ts * 1000).toISOString(), hash: current.hash, source: 'Kalshi public API', control: s.control,
      states: s.states.map((r) => ({ st: r.st, race: r.race, special: r.special, map: r.map, pD: r.pD, pR: r.pR, pO: r.pO, vol: r.vol, status: r.status, result: r.result, event: r.event, others: r.others })),
      anchored: posted ? { hash: posted.hash, ts: new Date(posted.ts * 1000).toISOString(), tx: posted.tx, url: `/api/snapshot/${posted.hash}` } : null,
    }
  }

  let timer = null
  function start(ms = 90_000) {
    if (mode === 'off') return
    const tick = () => poll().catch(() => {})
    tick(); timer = setInterval(tick, ms); timer.unref?.()
  }
  return { poll, freeze, view, current: () => current, start, stop: () => clearInterval(timer), status: () => ({ mode, ...last, known: known?.length ?? null }) }
}
