// Wiring: store + chain + oracle + book + holder + picks + kalshi + rounds + views + api.
// createTapeward(opts) is used by index.mjs (real) and the tests (injected chain / clock / store / book / kalshi).
import { EventEmitter } from 'node:events'
import { openStore } from './store.mjs'
import { createChain } from './chain.mjs'
import { createClock, feeds as feedList, rules as rulesOf, token as tokenOf, chainMode } from './config.mjs'
import { createOracle } from './oracle.mjs'
import { createBook } from './book.mjs'
import { createHolder } from './holder.mjs'
import { createPicks } from './picks.mjs'
import { createKalshi } from './kalshi.mjs'
import { createRounds } from './rounds.mjs'
import { createViews } from './views.mjs'
import { createApi } from './api.mjs'
import { createPrizes } from './prizes.mjs'

export function createTapeward(o = {}) {
  const log = o.log || console
  const store = o.store || openStore({ name: (o.bookOpts?.mode || chainMode()) === 'mock' ? 'tapeward-mock.db' : 'tapeward.db', ...(o.storeOpts || {}) })
  const chain = o.chain || createChain()
  const clock = o.clock || createClock()
  const bus = o.bus || new EventEmitter()
  bus.setMaxListeners(50)
  const feeds = o.feeds || feedList, rules = o.rules || rulesOf, token = o.token || tokenOf
  const oracle = createOracle({ store, chain, clock, bus, feeds, log })
  const book = o.book || createBook({ store, chain, clock, log, feeds, ...(o.bookOpts || {}) })
  const holder = o.holder || createHolder({ chain, clock, token })
  const picks = createPicks({ store, holder, clock, bus, rules, token, log })
  const kalshi = o.kalshi === null ? null : o.kalshi || createKalshi({ store, clock, bus, log, ...(o.kalshiOpts || {}) })
  const rounds = createRounds({ store, book, oracle, picks, holder, kalshi, clock, bus, feeds, rules, token, log, deskAccount: o.deskAccount })
  let views = null
  const prizes = o.prizes === null ? null : createPrizes({ store, chain, clock, bus, holder, views: () => views, token, log, mode: o.bookOpts?.mode || undefined, ...(o.prizeOpts || {}) })
  views = createViews({ store, oracle, kalshi, book, rounds, holder, clock, feeds, rules, token, prizes })
  const api = createApi({ store, views, picks, kalshi, oracle, book, clock, bus, chain, token, prizes, trustProxy: o.trustProxy })

  const timers = []
  async function start({ tickMs = 5000 } = {}) {
    try { await oracle.poll() } catch {}
    oracle.start()
    kalshi?.start()
    prizes?.start()
    let busy = false
    const loop = async () => { if (busy) return; busy = true; try { await rounds.tick() } catch (e) { log.error?.(`tick: ${e.stack || e.message}`) } finally { busy = false } }
    loop()
    timers.push(setInterval(loop, tickMs))
    for (const t of timers) t.unref?.()
  }
  function stop() { oracle.stop(); kalshi?.stop(); prizes?.stop(); for (const t of timers) clearInterval(t); api.close?.() }
  return { store, chain, clock, bus, oracle, book, holder, picks, kalshi, rounds, views, api, prizes, start, stop }
}
