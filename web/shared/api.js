// TAPEWARD API client. Same origin (/api/*, owned by SERVER). Tolerant normalizers so small shape changes don't break pages.
// Fixture mode for local work without a server: ?fixture=1 (mid-session, market open), ?fixture=closed (before the open),
// ?fixture=election (after the Election Night lock, some races called). Fixtures live in /dev/ (never deployed).

import { clock, toDate } from './site.js'

const q = new URLSearchParams(location.search)
export let FIXTURE = q.get('fixture')
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost|.*\.test)$/.test(location.hostname)
const FX = { 1: 'state', open: 'state', closed: 'state-closed', election: 'state-election', server: 'server/state' }

async function j(url, opts) {
  const r = await fetch(url, { cache: 'no-store', ...opts })
  let body = null
  try { body = await r.json() } catch {}
  if (!r.ok) { const e = new Error(body?.error || body?.reason || `${url} → ${r.status}`); e.status = r.status; e.body = body; throw e }
  return body
}
const fx = (name) => j(`/dev/fixtures/${name}.json`)

// ── normalizers ───────────────────────────────────────────────────────────────────────────────
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v))
const arr = (v) => (Array.isArray(v) ? v : [])

export function normAnchor(a, i) {
  if (!a) return null
  return { n: num(a.n ?? a.index ?? a.seq) ?? i + 1, root: a.root, count: num(a.count ?? a.leaves ?? a.leafCount), tx: a.tx ?? a.txHash ?? null, at: toDate(a.at ?? a.ts ?? a.postedAt ?? a.time), round: a.round ?? a.roundId }
}
export function normResult(r, i) {
  if (!r) return null
  return {
    i: num(r.i ?? r.index ?? r.scoreIndex) ?? i, label: r.label || (i === 0 ? 'Score' : 'Aftershock'),
    redBp: num(r.redBp ?? r.red), blueBp: num(r.blueBp ?? r.blue), refBp: num(r.refBp ?? r.ref), spreadBp: num(r.spreadBp ?? r.spread),
    tx: r.tx ?? r.txHash ?? null, at: toDate(r.settledAt ?? r.at ?? r.ts), scoreTime: toDate(r.scoreTime ?? r.time ?? r.at),
    settled: r.settled !== false && (r.spreadBp ?? r.spread) != null,
  }
}
// prize of a round, SERVER shape (rounds[].prize in /api/state and /api/round/:id):
// {split, pct, locked, budgetUsd, valueUsdAtLock, lockedAt, estimateUsd, noPrize, note, paidAfter, decided, winners}
export function normPrize(p) {
  if (!p) return null
  const split = arr(p.split)
  const usdV = num(p.locked ? p.budgetUsd : p.estimateUsd ?? p.budgetUsd)
  return { usd: usdV, top: split.length, split, pct: num(p.pct), locked: !!p.locked, estimate: !p.locked, none: p.noPrize === true, note: p.note || null, paidAfter: p.paidAfter || null, decided: !!p.decided, winners: arr(p.winners) }
}
export function normRound(r) {
  if (!r) return null
  const id = r.id ?? r.roundId ?? r.name
  const kind = r.kind ?? r.type ?? (/^ELECTION/i.test(id || '') ? 'election' : 'daily')
  const scoreTimes = arr(r.scoreTimes ?? r.score_times ?? (r.scoreAt ? [r.scoreAt] : [])).map(toDate).filter(Boolean)
  const out = {
    raw: r, id, kind, id32: r.id32 ?? r.idHex ?? r.bytes32 ?? r.key ?? null,
    label: r.label || (kind === 'election' ? 'Election Night' : `Daily · ${String(id || '').replace(/^D-/, '')}`),
    picksOpen: toDate(r.picksOpen ?? r.opensAt ?? r.openAt),
    picksClose: toDate(r.picksClose ?? r.picks_close ?? r.closeAt),
    lock: toDate(r.lock ?? r.lockTime ?? r.lock_time ?? r.lockAt),
    scoreTimes,
    scoreLabels: arr(r.scoreLabels).length ? r.scoreLabels : kind === 'election' ? ['Day one', 'Aftershock'] : ['Close'],
    status: r.status ?? null,
    picks: num(r.picks ?? r.count ?? r.counts?.picks ?? r.pickCount),
    wallets: num(r.wallets ?? r.counts?.wallets),
    // server sends anchors as {count, last}; fixtures/older shapes as a list
    anchors: Array.isArray(r.anchors) ? r.anchors.map(normAnchor).filter(Boolean) : r.anchors?.last ? [normAnchor(r.anchors.last, 0)] : [],
    anchorCount: Array.isArray(r.anchors) ? r.anchors.length : num(r.anchors?.count) ?? 0,
    nextAnchorAt: toDate(r.anchors?.nextAt ?? r.nextAnchorAt),
    results: arr(r.results).map(normResult).filter((x) => x && x.settled),
    openTx: r.opened?.tx ?? r.openTx ?? null,
    slots: r.slots || null,
    house: r.house ?? r.desk ?? null,
    prize: normPrize(r.prize),
  }
  if (!out.status) out.status = roundStatus(out)
  return out
}
export function roundStatus(r, now = clock.now()) {
  if (r.picksOpen && now < r.picksOpen) return 'upcoming'
  if (r.picksClose && now < r.picksClose) return 'open'
  if (r.lock && now < r.lock) return 'closed'
  const last = r.scoreTimes[r.scoreTimes.length - 1]
  if (last && now < last) return 'locked'
  return r.results.length >= r.scoreTimes.length && r.scoreTimes.length ? 'scored' : 'settling'
}
export function liveStatus(r) { return r ? roundStatus(r) : null }

export function normFeed(f, basket) {
  if (!f) return null
  const p = num(f.price ?? f.answer ?? f.end), s = num(f.startPrice ?? f.start)
  return {
    symbol: f.symbol, name: f.name || null, basket: f.basket || basket, price: p, startPrice: s,
    bp: num(f.bp) ?? (p != null && s ? Math.trunc(((p - s) / s) * 10000) : null),
    roundId: f.roundId != null ? String(f.roundId) : null, updatedAt: toDate(f.updatedAt), proxy: f.proxy || f.address || null,
  }
}
function normSide(s, basket) {
  if (!s) return { bp: null, live: true, feeds: [] }
  return { bp: num(s.bp), live: s.live !== false, feeds: arr(s.feeds).map((f) => normFeed(f, basket)).filter(Boolean) }
}
export function normKalshi(k) {
  if (!k) return null
  const by = {}
  for (const s of arr(k.states)) {
    const st = String(s.st ?? s.state ?? '').toUpperCase(); if (!st) continue
    const pD0 = num(s.pD), pR0 = num(s.pR)
    const pD = pD0 ?? (pR0 != null ? 1 - pR0 : null)
    const row = { st, race: String(s.race || 'senate').toLowerCase(), pD, pR: pR0 ?? (pD != null ? 1 - pD : null), vol: num(s.vol ?? s.volume), status: s.status || null, result: s.result || null, ticker: s.ticker || s.event || null, map: s.map, special: !!s.special }
    ;(by[st] ||= []).push(row)
  }
  // Senate first, governor when the state has no Senate race
  const states = {}
  for (const [st, rows] of Object.entries(by)) {
    const main = rows.find((r) => r.map === true) || rows.find((r) => r.race === 'senate') || rows[0]
    states[st] = { ...main, all: rows }
  }
  return { ts: toDate(k.ts ?? k.at), hash: k.hash ?? null, tx: k.tx ?? k.snapshotTx ?? null, control: k.control || {}, states }
}
export function normDesk(d) {
  if (!d) return null
  const rec = d.record || {}
  return { ...d, record: { calls: num(rec.rounds ?? rec.picks) ?? 0, scored: num(rec.scored), right: num(rec.right) ?? 0, missed: num(rec.missed ?? rec.wrong) ?? 0, points: num(rec.points), avg: num(rec.avg), rows: arr(d.last ?? rec.rows) } }
}
export function normState(s) {
  if (!s) return null
  if (s.now) clock.set(s.now)
  const rounds = arr(s.rounds).map(normRound).filter(Boolean)
  const race = s.race ? {
    roundId: s.race.roundId ?? s.race.round ?? null, since: toDate(s.race.since ?? s.race.start ?? s.race.lock), asOf: toDate(s.race.updatedAt ?? s.race.asOf ?? s.race.at ?? s.now), basis: s.race.basis || null, until: toDate(s.race.until), note: s.race.note || null,
    red: normSide(s.race.red, 'RED'), blue: normSide(s.race.blue, 'BLUE'), ref: normSide(s.race.ref, 'REF'),
    spreadBp: num(s.race.spreadBp ?? s.race.spread), official: !!s.race.official,
  } : null
  if (race && race.spreadBp == null && race.red.bp != null && race.blue.bp != null) race.spreadBp = race.red.bp - race.blue.bp
  // the Election round since its lock, when the server sends it separately
  const election = s.raceElection || s.electionRace || s.race_election || null
  return {
    raw: s, now: toDate(s.now), token: s.token || null, chain: s.chain || null,
    market: { open: !!s.market?.open, openAt: toDate(s.market?.openAt), closeAt: toDate(s.market?.closeAt), nextOpen: toDate(s.market?.nextOpen), nextClose: toDate(s.market?.nextClose) },
    rounds, race,
    electionRace: election ? { since: toDate(election.since), red: normSide(election.red, 'RED'), blue: normSide(election.blue, 'BLUE'), ref: normSide(election.ref, 'REF'), spreadBp: num(election.spreadBp) } : null,
    kalshi: normKalshi(s.kalshi), desk: normDesk(s.desk), counts: s.counts || {},
    lastAnchor: s.lastAnchor ? normAnchor(s.lastAnchor, 0) : null,
    fixture: !!FIXTURE,
  }
}

// ── endpoints ─────────────────────────────────────────────────────────────────────────────────
export async function getState() {
  if (FIXTURE) return normState(await fx(FX[FIXTURE] || 'state'))
  try { return normState(await j('/api/state')) } catch (e) {
    // local dev with no SERVER running: fall back to the fixtures and say so on the page
    if (LOCAL && !e.status) { FIXTURE = '1'; return normState(await fx('state')) }
    if (LOCAL && e.status === 404) { FIXTURE = '1'; return normState(await fx('state')) }
    throw e
  }
}
export const getRound = (id) => (FIXTURE ? fx('round') : j(`/api/round/${encodeURIComponent(id)}`))
export const getPicks = (id) => (FIXTURE ? fx('picks') : j(`/api/round/${encodeURIComponent(id)}/picks`))
export const getBoard = (id) => (FIXTURE ? fx('board') : j(`/api/board${id ? `?round=${encodeURIComponent(id)}` : ''}`))
export const getWallet = (a) => (FIXTURE ? fx('wallet') : j(`/api/wallet/${a}`))
export const getProof = () => (FIXTURE ? fx('proof') : j('/api/proof'))
export const getPrizes = () => (FIXTURE ? fx('prizes') : j('/api/prizes'))
// what prizes are paid in right now, from the prize wallet's holdings: "ETH" when it holds no stock tokens
export const prizeInfo = { paidIn: null, holdings: null }
export async function loadPrizeInfo() {
  try {
    const p = await getPrizes()
    const hold = arr(p?.holdings).filter((x) => Number(x.amount) > 0)
    prizeInfo.holdings = hold
    prizeInfo.paidIn = hold.length ? 'stock tokens (or ETH)' : 'ETH'
  } catch {}
  return prizeInfo
}
export const getRules = async () => { try { return await j('/rules.json') } catch { return null } }
export async function postPick(body) {
  if (FIXTURE) {
    await new Promise((r) => setTimeout(r, 500))
    return { ok: true, fixture: true, pick: { ...body.pick, address: body.address }, nextAnchorAt: new Date(clock.now() + 40 * 60e3).toISOString() }
  }
  return j('/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

// live state: SSE /api/stream when the server has it, polling otherwise. cb(normalizedState)
export function subscribeState(cb, { pollMs = 20000 } = {}) {
  let last = null, es = null, timer = null, stopped = false
  const emit = (s) => { last = s; cb(s) }
  const poll = async () => { try { emit(await getState()) } catch (e) { cb(null, e) } }
  const startPoll = () => { clearInterval(timer); timer = setInterval(poll, pollMs) }
  poll().then(() => {
    if (stopped || FIXTURE || !('EventSource' in window)) { if (!FIXTURE) startPoll(); return }
    try {
      es = new EventSource('/api/stream')
      const onMsg = (ev) => {
        let d; try { d = JSON.parse(ev.data) } catch { return }
        if (!d || typeof d !== 'object') return
        if (d.rounds || d.race || d.kalshi) {
          const merged = last?.raw ? { ...last.raw, ...d } : d
          emit(normState(merged))
        }
      }
      es.onmessage = onMsg
      es.addEventListener('state', onMsg)
      es.onerror = () => { if (es.readyState === 2) { es = null; startPoll() } }
      // a slow safety poll even with SSE (anchors, rounds)
      timer = setInterval(poll, 60000)
    } catch { startPoll() }
  })
  return () => { stopped = true; clearInterval(timer); es?.close() }
}

// the round to show on the scoreboard / pick panel
export function pickRounds(state) {
  const rs = state?.rounds || []
  const daily = rs.filter((r) => r.kind === 'daily')
  const election = rs.find((r) => r.kind === 'election') || null
  const now = clock.now()
  const openDaily = daily.filter((r) => roundStatus(r, now) === 'open').sort((a, b) => a.lock - b.lock)[0] || null
  const liveDaily = daily.filter((r) => ['locked', 'closed'].includes(roundStatus(r, now))).sort((a, b) => b.lock - a.lock)[0] || null
  const lastDaily = daily.filter((r) => ['scored', 'settling'].includes(roundStatus(r, now))).sort((a, b) => b.lock - a.lock)[0] || null
  return { daily, election, openDaily, liveDaily, lastDaily }
}
