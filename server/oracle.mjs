// Chainlink reader: every 60 s latestRoundData() on all 13 proxies (one JSON-RPC batch), stored in feed_rounds + a per-minute history
// row for the live race. pointsAt(T) = for each feed the round settle() accepts for time T (cached once T is in the past);
// race(startMs) = live, unofficial basket numbers from those start points to the latest answers (official = settle() on chain).
import { feeds as feedList, iso } from './config.mjs'
import { basketBp, feedBp } from './score.mjs'

export const POLL_MS = 60_000

export function createOracle({ store, chain, clock, bus, feeds = feedList, log = console }) {
  let last = { at: null, ok: null, error: null }
  const points = new Map()   // T seconds → Promise<[point]>

  async function poll() {
    const fs = feeds()
    let rounds
    try { rounds = await chain.latestRounds(fs) } catch (e) { last = { at: clock(), ok: false, error: e.message }; return null }
    const now = clock(), data = {}
    let fresh = 0
    fs.forEach((f, i) => {
      const r = rounds[i]
      if (!r) return
      if (store.putFeedRound(r, now)) fresh++
      data[f.symbol] = [r.answer, r.roundId, r.updatedAt]
    })
    if (Object.keys(data).length) store.putHistory(Math.floor(now / 60_000), data)
    if (Math.random() < 0.01) store.pruneHistory(Math.floor(now / 60_000) - 60 * 24 * 30)
    last = { at: now, ok: true, error: null, feeds: Object.keys(data).length }
    if (fresh) bus?.emit('prices', { fresh })
    return data
  }

  /** latest stored round per symbol */
  const latest = (symbol) => store.lastFeedRound(symbol)

  /** [point] in feed order: the latest round with updatedAt ≤ T for each feed (null when T is still in the future) */
  async function pointsAt(tMs) {
    const T = Math.floor(tMs / 1000)
    if (tMs > clock()) return null
    if (!points.has(T)) {
      const p = Promise.all(feeds().map(async (f) => {
        const r = await chain.findRoundAt(f, T)
        if (!r) throw new Error(`${f.symbol}: no round at ${iso(tMs)}`)
        return { symbol: f.symbol, roundId: r.roundId, answer: r.answer, updatedAt: r.updatedAt }
      }))
      points.set(T, p)
      p.catch(() => points.delete(T))
      if (points.size > 64) points.delete(points.keys().next().value)
    }
    return points.get(T)
  }

  /** race from startMs to endMs (or to the latest answers while endMs is in the future): { red, blue, ref: {bp, live, feeds[]}, spreadBp, updatedAt } */
  async function race(startMs, endMs = null) {
    const fs = feeds()
    let start, end = null
    try {
      start = await pointsAt(startMs)
      if (endMs != null && endMs <= clock()) end = await pointsAt(endMs)
    } catch (e) { log.error?.(`oracle: race points: ${e.message}`); return null }
    if (!start) return null
    const rows = fs.map((f, k) => {
      const cur = end ? end[k] : latest(f.symbol)
      const s = start[k]
      const useCur = cur && cur.updatedAt >= s.updatedAt ? cur : s
      return {
        symbol: f.symbol, name: f.name, basket: f.basket, proxy: f.proxy,
        price: Number(useCur.answer) / 10 ** f.decimals, answer: useCur.answer, roundId: useCur.roundId, updatedAt: iso(useCur.updatedAt * 1000),
        startPrice: Number(s.answer) / 10 ** f.decimals, startAnswer: s.answer, startRoundId: s.roundId, startUpdatedAt: iso(s.updatedAt * 1000),
        bp: feedBp(s.answer, useCur.answer),
      }
    })
    const basket = (b) => {
      const fr = rows.filter((r) => r.basket === b)
      return { bp: basketBp(fr.map((r) => r.startAnswer), fr.map((r) => r.answer)), live: true, feeds: fr.map(({ basket, ...r }) => r) }
    }
    const red = basket('RED'), blue = basket('BLUE'), ref = basket('REF')
    if (end) for (const b of [red, blue, ref]) b.live = false
    const upd = rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), '')
    return { red, blue, ref, spreadBp: red.bp - blue.bp, updatedAt: upd || null }
  }

  /** per-minute series of {t, red, blue, ref, spread} bp since startMs (from history rows) */
  async function series(startMs, endMs = clock(), stepMin = 5) {
    const start = await pointsAt(startMs).catch(() => null)
    if (!start) return []
    const fs = feeds()
    const out = []
    let lastMin = -Infinity
    for (const h of store.history(Math.floor(startMs / 60_000), Math.floor(endMs / 60_000))) {
      if (h.minute - lastMin < stepMin) continue
      lastMin = h.minute
      const ans = fs.map((f, k) => h.data[f.symbol]?.[0] ?? start[k].answer)
      const b = (name) => { const ks = fs.map((f, k) => (f.basket === name ? k : -1)).filter((k) => k >= 0); return basketBp(ks.map((k) => start[k].answer), ks.map((k) => ans[k])) }
      const red = b('RED'), blue = b('BLUE')
      out.push({ t: iso(h.minute * 60_000), red, blue, ref: b('REF'), spread: red - blue })
    }
    return out
  }

  let timer = null
  function start() {
    const tick = () => poll().catch((e) => log.error?.(`oracle: ${e.message}`))
    tick(); timer = setInterval(tick, POLL_MS); timer.unref?.()
  }
  return { poll, latest, pointsAt, race, series, start, stop: () => clearInterval(timer), status: () => last }
}
