// Round engine (one tick every few seconds):
//   1. create rounds that are due (daily 24 h before lock, ELECTION-2026 at once) → RaceBook.openRound (retried until it lands)
//   2. house desk pick ("TAPEWARD desk": last-5-sessions momentum) as soon as picks open
//   3. anchors: every UTC hour while picks are open (only when the leaf set changed) + a final root at picksClose (before lock).
//      At the final anchor, extra ELECTION slots of wallets that no longer hold the token are voided.
//   4. settle every score time from T + 10 min (contract SETTLE_DELAY); start/end rounds found with chain.findRoundAt
//   5. hourly Kalshi snapshot hash → RaceBook.postSnapshot
// Desk key: env DESK_PK, else the poster key; in CHAIN_MODE=mock without keys a throwaway key is generated and kept in the DB.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { rules as rulesOf, publicUrl, token as tokenOf, gateOn, iso } from './config.mjs'
import { roundsDue, lastClosedSessions, roundStatus, roundHex } from './calendar.mjs'
import { buildTree, basketBp } from './score.mjs'
import { loadPoster, SETTLE_DELAY_S } from './book.mjs'
import { typedDataFor } from './picks.mjs'

const HOUR = 3_600_000
export const SETTLE_MARGIN_MS = 30_000
const okStatus = (s) => s === 'confirmed' || s === 'mock'

/** is an anchor due? (pure; exported for tests)
 *  first anchor: as soon as there are leaves · then: once per UTC hour while the leaf set changes · final: at picksClose (before lock) */
export function anchorDue({ now, round, last, leavesChanged }) {
  if (now < round.opensAt || now >= round.lockTime) return null
  if (now >= round.picksClose) return last?.final && okStatus(last.status) ? null : 'final'
  if (!leavesChanged) return null
  if (!last) return 'first'
  return Math.floor(now / HOUR) > Math.floor(last.at / HOUR) ? 'hourly' : null
}

/** desk side/spread from 5-session basket returns (pure) */
export function deskCall(redBp, blueBp, kind) {
  const s5 = redBp - blueBp
  const raw = kind === 'election' ? s5 : Math.trunc(s5 / 5)
  const spreadBp = Math.max(-2000, Math.min(2000, raw))
  return { side: spreadBp >= 0 ? 0 : 1, spreadBp }
}

export function createRounds({ store, book, oracle, picks, holder, kalshi, clock, bus, feeds, rules = rulesOf, token = tokenOf, log = console, deskAccount }) {
  let deskAcct = deskAccount
  function desk() {
    if (deskAcct !== undefined) return deskAcct
    const k = process.env.DESK_PK
    if (k && /^(0x)?[0-9a-fA-F]{64}$/.test(k)) return (deskAcct = privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k))
    const p = book.isMock() ? null : loadPoster()
    if (p) return (deskAcct = p)
    if (book.isMock()) {
      let key = store.kv('desk:mockkey')
      if (!key) { key = generatePrivateKey(); store.setKv('desk:mockkey', key) }
      return (deskAcct = privateKeyToAccount(key))
    }
    return (deskAcct = null)
  }

  const uriOf = (id) => `${publicUrl()}/api/round/${id}/picks`
  const livePicks = (id) => store.picksOf(id).filter((p) => !p.void)
  const nextTry = new Map()
  const wait = (k, ms) => { const t = nextTry.get(k); if (t && clock() < t) return true; nextTry.set(k, clock() + ms); return false }

  // ───────────────────────────── 1. create + open
  async function create() {
    const now = clock()
    const have = new Set(store.rounds().map((r) => r.id))
    for (const plan of roundsDue(now, rules(), have)) {
      if (store.putRound(plan, now)) { log.log?.(`rounds: created ${plan.id} (lock ${iso(plan.lockTime)})`); bus?.emit('round', { id: plan.id }) }
    }
    for (const r of store.rounds()) {
      if (okStatus(r.openStatus) || r.openStatus === 'sent' || now >= r.picksClose) continue
      if (wait('open:' + r.id, 60_000)) continue
      try {
        const out = await book.openRound(r)
        store.setOpen(r.id, out.status, { tx: out.tx, at: now, error: null })
        log.log?.(`rounds: openRound ${r.id} → ${out.status} ${out.tx}`)
      } catch (e) {
        if (/RoundExists/.test(e.message)) { store.setOpen(r.id, 'confirmed', { error: 'already open on chain' }); continue }
        store.setOpen(r.id, 'failed', { error: e.message })
        log.error?.(`rounds: openRound ${r.id}: ${e.message}`)
      }
    }
  }

  // ───────────────────────────── 2. house desk
  async function deskPicks() {
    const acct = desk()
    if (!acct) return
    const now = clock()
    for (const r of store.rounds()) {
      if (r.desk || now < r.opensAt || now >= r.picksClose - 60_000) continue
      if (wait('desk:' + r.id, 120_000)) continue
      try {
        const sess = lastClosedSessions(now, 6)
        if (sess.length < 6) continue
        const [a, b] = await Promise.all([oracle.pointsAt(sess[5].close), oracle.pointsAt(sess[0].close)])
        const fs = feeds()
        const bp = (name) => { const ks = fs.map((f, k) => (f.basket === name ? k : -1)).filter((k) => k >= 0); return basketBp(ks.map((k) => a[k].answer), ks.map((k) => b[k].answer)) }
        const red5 = bp('RED'), blue5 = bp('BLUE')
        const call = deskCall(red5, blue5, r.kind)
        const pick = { round: r.id, roundHex: roundHex(r.id), side: call.side, spreadBp: call.spreadBp, slot: 0, signedAt: Math.floor(now / 1000) }
        const signature = await acct.signTypedData(typedDataFor(pick))
        const out = await picks.submit({ pick, signature, address: acct.address }, { trusted: true })
        if (!out.ok) { log.error?.(`desk: ${r.id}: ${out.error}`); continue }
        store.setDesk(r.id, { address: acct.address, side: call.side ? 'BLUE' : 'RED', spreadBp: call.spreadBp, signedAt: pick.signedAt, basis: { from: iso(sess[5].close), to: iso(sess[0].close), redBp: red5, blueBp: blue5 } })
        log.log?.(`desk: ${r.id} → ${call.side ? 'BLUE' : 'RED'} ${call.spreadBp} bp (5 sessions: RED ${red5} / BLUE ${blue5})`)
      } catch (e) { log.error?.(`desk: ${r.id}: ${e.message}`) }
    }
  }

  // ───────────────────────────── 3. anchors
  async function voidLostSlots(r) {
    if (!gateOn(token()) || r.kind !== 'election') return
    for (const p of livePicks(r.id).filter((x) => x.slot > 0)) {
      const h = await holder.status(p.picker, { fresh: true })
      if (!h.holder && !h.error) { store.voidPick(r.id, p.picker, p.slot, 'not a holder at picks close'); log.log?.(`anchor: voided ${r.id} ${p.picker} slot ${p.slot}`) }
    }
  }

  async function anchorRound(r, kind) {
    if (kind === 'final') await voidLostSlots(r)
    const ps = livePicks(r.id)
    if (!ps.length) return null
    const tree = buildTree(ps.map((p) => ({ ...p, roundHex: roundHex(r.id) })))
    const last = store.lastAnchor(r.id)
    const confirmed = last && okStatus(last.status) ? last : store.anchorsOf(r.id).filter((a) => okStatus(a.status)).pop()
    if (confirmed && confirmed.root === tree.root) {
      if (kind === 'final' && !confirmed.final) store.markFinal(r.id, confirmed.n)
      return null
    }
    if (last && (last.status === 'failed' || last.status === 'sending')) store.deleteAnchor(r.id, last.n)
    const n = (confirmed?.n || 0) + 1
    const leaves = ps.map((p) => p.leaf).sort()
    store.putAnchor({ round: r.id, n, root: tree.root, count: ps.length, leaves, uri: uriOf(r.id), final: kind === 'final', status: 'sending', at: clock() })
    try {
      const out = await book.anchor(r, tree.root, ps.length, uriOf(r.id), confirmed?.count || 0)
      store.setAnchor(r.id, n, out.status, { tx: out.tx, block: out.block ?? null })
      log.log?.(`anchor: ${r.id} #${n} ${kind} root ${tree.root.slice(0, 10)}… count ${ps.length} → ${out.status} ${out.tx}`)
      if (okStatus(out.status)) bus?.emit('anchor', { round: r.id, n, root: tree.root, count: ps.length, tx: out.tx, final: kind === 'final' })
      return out
    } catch (e) {
      store.setAnchor(r.id, n, 'failed', { error: e.message })
      log.error?.(`anchor: ${r.id} #${n}: ${e.message}`)
      return null
    }
  }

  async function anchors() {
    const now = clock()
    for (const r of store.rounds()) {
      if (now >= r.lockTime || now < r.opensAt || !okStatus(r.openStatus)) continue
      const last = store.lastAnchor(r.id)
      if (last?.status === 'sent' && now - last.at < 5 * 60_000) continue
      const okLast = store.anchorsOf(r.id).filter((a) => okStatus(a.status)).pop()
      const leaves = livePicks(r.id).map((p) => p.leaf).sort()
      const changed = !okLast || okLast.leaves.join() !== leaves.join()
      const kind = anchorDue({ now, round: r, last: okLast, leavesChanged: changed && leaves.length > 0 })
      if (!kind) continue
      if (last?.status === 'failed' && wait('anchor:' + r.id, 30_000)) continue
      await anchorRound(r, kind)
    }
  }

  // ───────────────────────────── 4. settle
  async function settle() {
    const now = clock()
    for (const r of store.rounds()) {
      if (!okStatus(r.openStatus)) continue
      for (let i = 0; i < r.scoreTimes.length; i++) {
        const T = r.scoreTimes[i]
        if (now < T + SETTLE_DELAY_S * 1000 + SETTLE_MARGIN_MS) continue
        store.ensureResult(r.id, i)
        const res = store.resultsOf(r.id).find((x) => x.idx === i)
        if (okStatus(res.status)) continue
        if (i > 0 && !okStatus(store.resultsOf(r.id).find((x) => x.idx === 0)?.status)) continue
        if (wait(`settle:${r.id}:${i}`, Math.min(30 * 60_000, 60_000 * (1 + res.tries)))) continue
        try {
          const first = store.resultsOf(r.id).find((x) => x.idx === 0)
          const storedStart = i > 0 && first?.start ? first.start : null
          const start = storedStart || await oracle.pointsAt(r.lockTime)
          const end = await oracle.pointsAt(T)
          const out = await book.settle(r, i, storedStart ? [] : start.map((p) => p.roundId), end.map((p) => p.roundId), storedStart)
          const result = out.result || null
          store.setResult(r.id, i, { status: out.status, ...(result || {}), start: result?.start || start, end: result?.end || end, tx: out.tx, block: out.block ?? null, at: now, error: null })
          log.log?.(`settle: ${r.id} [${i}] → ${out.status} ${out.tx}${result ? ` spread ${result.spreadBp}` : ''}`)
          if (okStatus(out.status)) bus?.emit('settled', { round: r.id, idx: i, ...(result || {}), tx: out.tx })
        } catch (e) {
          if (/AlreadySettled/.test(e.message) && !book.isMock()) {
            try { const v = await book.readResult(r.id, i); store.setResult(r.id, i, { status: 'confirmed', ...v, at: now, error: 'settled by another caller' }); continue } catch {}
          }
          store.setResultError(r.id, i, 'failed', e.message)
          log.error?.(`settle: ${r.id} [${i}]: ${e.message}`)
        }
      }
    }
  }

  // ───────────────────────────── 5. Kalshi snapshot hash
  async function snapshots() {
    if (!kalshi) return
    const now = clock()
    const lastPosted = store.lastSnapshot()
    if (lastPosted && Math.floor(now / HOUR) <= Math.floor(lastPosted.ts * 1000 / HOUR) && lastPosted.status !== 'failed') return
    if (wait('snapshot', 60_000)) return
    const cur = kalshi.current()
    if (!cur || (lastPosted && cur.hash === lastPosted.hash && lastPosted.status !== 'failed')) return
    if (now - cur.snapshot.ts * 1000 > 30 * 60_000) return   // stale (Kalshi unreachable): do not re-post old data
    const s = kalshi.freeze()
    if (!s) return
    try {
      const out = await book.postSnapshot(s.hash, s.ts, `${publicUrl()}/api/snapshot/${s.hash}`)
      store.setSnapshot(s.hash, out.status, { tx: out.tx, at: now, error: null })
      log.log?.(`snapshot: ${s.hash.slice(0, 12)}… → ${out.status} ${out.tx}`)
      bus?.emit('snapshot', { hash: s.hash, tx: out.tx })
    } catch (e) {
      store.setSnapshot(s.hash, 'failed', { error: e.message })
      log.error?.(`snapshot: ${e.message}`)
    }
  }

  let busy = false
  async function tick() {
    if (busy) return
    busy = true
    try {
      await create()
      await deskPicks()
      await anchors()
      await settle()
      await snapshots()
    } finally { busy = false }
  }

  /** public status of a round at now */
  function statusOf(r) {
    const settled = store.resultsOf(r.id).filter((x) => okStatus(x.status)).length
    return roundStatus(r, clock(), settled)
  }
  return { tick, create, deskPicks, anchors, anchorRound, settle, snapshots, statusOf, desk: () => desk() }
}
