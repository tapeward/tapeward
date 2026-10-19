// JSON views behind the API (state, round, picks, board, wallet, proof). Shapes = server/fixtures/*.json (WEB builds against them).
import { getAddress, toFunctionSelector } from 'viem'
import { iso, link, token as tokenOf, gateOn, rules as rulesOf, racebookConfig, publicUrl, CHAIN_ID, EXPLORER, appName } from './config.mjs'
import { sessionAt, lastSessionOpened, nextSessionAfter, roundHex, upcomingDaily } from './calendar.mjs'
import { buildTree, proofsOf, rankBoard, pickScore, LEAF_ENCODING } from './score.mjs'
import { slotsFor } from './picks.mjs'
import { racebookAbi } from './book.mjs'

const okStatus = (s) => s === 'confirmed' || s === 'mock'
const txLink = (tx) => link.tx(tx)
const sideName = (s) => (Number(s) === 1 ? 'BLUE' : 'RED')
const HOUR = 3_600_000
export const POSTER = '0x9ed6dB374aEE462fA60432254bace118a90Fe1C9'
export const OWNER = '0x262336915b1D10f7b071EE555B885ae48E7E6D9a'

export function createViews({ store, oracle, kalshi, book, rounds, holder, clock, feeds, rules = rulesOf, token = tokenOf, prizes = null }) {
  const anchorView = (a) => a && ({ n: a.n, root: a.root, count: a.count, at: iso(a.at), tx: a.tx, link: txLink(a.tx), status: a.status, final: !!a.final, uri: a.uri })
  const okAnchors = (id) => store.anchorsOf(id).filter((a) => okStatus(a.status))
  const resultsView = (r) => {
    const rs = store.resultsOf(r.id)
    return r.scoreTimes.map((t, i) => {
      const x = rs.find((y) => y.idx === i)
      const settled = !!x && okStatus(x.status)
      return { index: i, label: r.scoreLabels[i], at: iso(t), settled, redBp: settled ? x.redBp : null, blueBp: settled ? x.blueBp : null, refBp: settled ? x.refBp : null,
        spreadBp: settled ? x.spreadBp : null, tx: settled ? x.tx : null, link: settled ? txLink(x.tx) : null, settledAt: settled ? iso(x.at) : null, ...(x && !settled && x.error ? { error: x.error } : {}) }
    })
  }
  /** picks of a round stay sealed (no side / spread anywhere in the public API) until picks close */
  const isSealed = (r) => clock() < r.picksClose
  const deskView = (r) => (!r.desk ? null : isSealed(r) ? { sealed: true, signedAt: iso(r.desk.signedAt * 1000) }
    : { side: r.desk.side, spreadBp: r.desk.spreadBp, signedAt: iso(r.desk.signedAt * 1000), basis: r.desk.basis || null })

  /** per-round counters: every pick (desk included, marked), anchors on chain, last anchor */
  function countersOf(r) {
    const ps = store.picksOf(r.id).filter((p) => !p.void)
    const deskAddr = r.desk?.address?.toLowerCase()
    const deskPicks = deskAddr ? ps.filter((p) => p.picker.toLowerCase() === deskAddr).length : 0
    const as = okAnchors(r.id)
    const last = as.at(-1) || null
    return { picks: ps.length, wallets: new Set(ps.map((p) => p.picker)).size, deskPicks, userPicks: ps.length - deskPicks, anchors: as.length,
      anchoredLeaves: last ? last.count : 0, pending: Math.max(0, ps.length - (last ? last.leaves.filter((h) => ps.some((p) => p.leaf === h)).length : 0)),
      lastAnchor: last ? { n: last.n, tx: last.tx, link: txLink(last.tx), at: iso(last.at), count: last.count, root: last.root } : null }
  }
  function summary(r, role = null, holderStatus = null) {
    const c = store.pickCount(r.id)
    const as = okAnchors(r.id)
    const last = as.at(-1) || null
    return {
      counters: countersOf(r),
      id: r.id, idHex: roundHex(r.id), kind: r.kind, label: r.label, day: r.day, opensAt: iso(r.opensAt), picksClose: iso(r.picksClose), lockTime: iso(r.lockTime),
      scoreTimes: r.scoreTimes.map(iso), scoreLabels: r.scoreLabels, role, status: rounds.statusOf(r), picks: c.picks, wallets: c.wallets,
      slots: { you: holderStatus ? slotsFor(r, holderStatus, rules(), token()) : null, default: rules().slots.default, holder: gateOn(token()) && r.kind === 'election' ? rules().slots.holder_election : rules().slots.default },
      opened: r.openTx ? { status: r.openStatus, tx: r.openTx, link: txLink(r.openTx), at: iso(r.openAt) } : { status: r.openStatus, tx: null, link: null, at: null },
      anchors: { count: as.length, last: anchorView(last), nextAt: nextAnchorAt(r) },
      results: resultsView(r), desk: deskView(r), prize: prizes ? prizes.roundPrize(r) : null,
    }
  }
  function nextAnchorAt(r) {
    const now = clock()
    if (now >= r.picksClose) return null
    const nextHour = (Math.floor(now / HOUR) + 1) * HOUR
    return iso(Math.min(Math.max(nextHour, r.opensAt), r.picksClose))
  }

  /** current (locked/live/last settled daily) + next (open/upcoming daily) + election */
  function stateRounds() {
    const now = clock()
    const all = store.rounds()
    const daily = all.filter((r) => r.kind === 'daily')
    const current = daily.filter((r) => r.lockTime <= now).pop() || null
    const next = daily.find((r) => r.lockTime > now) || null
    const out = []
    if (current) out.push(summary(current, 'current'))
    if (next) out.push(summary(next, 'next'))
    else { const p = upcomingDaily(now, rules(), 1)[0]; if (p) out.push({ id: p.id, idHex: roundHex(p.id), kind: 'daily', label: p.label, day: p.day, opensAt: iso(p.opensAt), picksClose: iso(p.picksClose), lockTime: iso(p.lockTime), scoreTimes: p.scoreTimes.map(iso), scoreLabels: p.scoreLabels, role: 'next', status: 'scheduled', picks: 0, wallets: 0, createAt: iso(p.createAt),
      counters: { picks: 0, wallets: 0, deskPicks: 0, userPicks: 0, anchors: 0, anchoredLeaves: 0, pending: 0, lastAnchor: null, scheduled: true },
      prize: prizes ? prizes.roundPrize({ id: p.id, kind: 'daily', scoreLabels: p.scoreLabels }) : null, anchors: { count: 0, last: null, nextAt: null }, results: [], desk: null }) }
    const el = all.find((r) => r.kind === 'election')
    if (el) out.push(summary(el, 'election'))
    return out
  }

  let raceCache = { at: 0, key: null, v: null }
  async function raceNow() {
    const now = clock()
    const s = lastSessionOpened(now)
    if (!s) return null
    const key = s.open
    if (raceCache.key === key && clock.real() - raceCache.at < 15_000) return raceCache.v
    const r = await oracle.race(s.open, s.close)
    const round = store.getRound(`D-${s.day}`)
    const live = now < s.close
    const v = r && { round: round ? round.id : null, basis: round ? 'round' : 'session', since: iso(s.open), until: iso(s.close), live, official: false,
      note: 'live, unofficial: official numbers are the settle() result on chain', ...r }
    raceCache = { at: clock.real(), key, v }
    return v
  }
  let elCache = { at: 0, v: null }
  async function raceElection() {
    const el = store.rounds().find((r) => r.kind === 'election')
    if (!el || clock() < el.lockTime) return null
    if (clock.real() - elCache.at < 15_000) return elCache.v
    const r = await oracle.race(el.lockTime)
    const v = r && { round: el.id, basis: 'round', since: iso(el.lockTime), live: true, official: false, note: 'live, unofficial since lock; official = settle() results', ...r, results: resultsView(el) }
    elCache = { at: clock.real(), v }
    return v
  }

  function deskRecord() {
    const rows = []
    for (const r of store.rounds()) {
      if (!r.desk) continue
      const res = store.resultsOf(r.id).find((x) => x.idx === 0 && okStatus(x.status))
      const sc = res ? pickScore({ side: r.desk.side, spreadBp: r.desk.spreadBp }, res.spreadBp) : null
      rows.push({ round: r.id, ...(isSealed(r) ? { sealed: true } : { side: r.desk.side, spreadBp: r.desk.spreadBp }), actual: res ? res.spreadBp : null, score: sc ? sc.score : null, right: sc ? sc.sideRight : null, lockTime: r.lockTime })
    }
    rows.sort((a, b) => b.lockTime - a.lockTime)
    const scored = rows.filter((x) => x.score != null)
    const points = scored.reduce((s, x) => s + x.score, 0)
    return { rounds: rows.length, scored: scored.length, right: scored.filter((x) => x.right).length, missed: scored.filter((x) => !x.right).length,
      points: Math.round(points * 10) / 10, avg: scored.length ? Math.round((points / scored.length) * 10) / 10 : null, last: rows.slice(0, 10).map(({ lockTime, ...x }) => x) }
  }

  async function state() {
    const now = clock()
    const t = token()
    const s = sessionAt(now)
    const nx = nextSessionAfter(now)
    const deskAcct = rounds.desk()
    const rec = deskRecord()
    const totals = store.totals()
    const la = store.lastAnchorAny()
    const rb = racebookConfig().address
    let race = null, rel = null
    try { race = await raceNow() } catch {}
    try { rel = await raceElection() } catch {}
    return {
      now: iso(now), name: appName(), mode: gateOn(t) ? 'live' : 'preview',
      token: { name: t.name, symbol: t.symbol ?? null, ca: t.ca, launch_at: t.launch_at ?? null, holder_min: t.holder_min ?? 0, gate: gateOn(t) },
      chain: { id: CHAIN_ID, mode: book.mode, racebook: rb, racebookLink: link.address(rb), poster: book.posterAddress() || POSTER, explorer: EXPLORER },
      market: { open: !!s.isOpen, day: s.day, openAt: iso(s.open), closeAt: iso(s.close), nextOpen: iso(s.isOpen ? nx?.open : s.open), nextClose: iso(s.close), dst: s.dst },
      rounds: stateRounds(),
      race, raceElection: rel,
      kalshi: kalshi ? kalshi.view() : null,
      desk: { name: rules().house_desk.name, address: deskAcct?.address || null, rule: rules().house_desk.rule, record: { rounds: rec.rounds, scored: rec.scored, right: rec.right, missed: rec.missed, points: rec.points, avg: rec.avg }, last: rec.last },
      counts: (() => {
        const all = store.rounds().map(countersOf)
        const sum = (k) => all.reduce((n, c) => n + c[k], 0)
        return { picks: totals.picks, wallets: totals.wallets, deskPicks: sum('deskPicks'), userPicks: sum('userPicks'), anchors: store.anchorCount(),
          rounds: store.rounds().length, roundsOpenOnChain: store.rounds().filter((r) => okStatus(r.openStatus)).length, settled: store.recentResults(10_000).length,
          lastAnchor: la ? { round: la.round, n: la.n, tx: la.tx, link: txLink(la.tx), at: iso(la.at) } : null }
      })(),
      lastAnchor: la ? { round: la.round, ...anchorView(la) } : null,
      feedsUpdatedAt: race?.updatedAt ?? null,
    }
  }

  // ───────────────────────────── round + picks
  function anchorLeaves(a) {
    return a.leaves.map((h) => store.pickByLeaf(h)).filter(Boolean)
  }
  async function round(id) {
    const r = store.getRound(id)
    if (!r) return null
    const first = store.resultsOf(r.id).find((x) => x.idx === 0 && x.start)
    const status = rounds.statusOf(r)
    let live = null
    if (status === 'live' || status === 'scoring') {
      const lr = await oracle.race(r.lockTime, r.scoreTimes.find((t) => t > clock()) ?? r.scoreTimes.at(-1)).catch(() => null)
      if (lr) live = { round: r.id, basis: 'round', since: iso(r.lockTime), until: iso(r.scoreTimes.at(-1)), live: true, official: false, note: 'live, unofficial: official numbers are the settle() result on chain', ...lr }
    }
    return { ...summary(r, null), contract: racebookConfig().address, uri: `${publicUrl()}/api/round/${r.id}/picks`,
      anchors: store.anchorsOf(r.id).map(anchorView), startRounds: first?.start || [], endRounds: store.resultsOf(r.id).map((x) => ({ index: x.idx, points: x.end || [] })), live }
  }

  /** leaves + proofs of anchor n (default: last confirmed). Sealed (hashes + proofs) before picks close. */
  function picksDoc(id, n = null) {
    const r = store.getRound(id)
    if (!r) return null
    const as = okAnchors(id)
    const a = n ? as.find((x) => x.n === Number(n)) : as.at(-1)
    const sealed = clock() < r.picksClose
    const base = { round: r.id, idHex: roundHex(r.id), contract: racebookConfig().address, chainId: CHAIN_ID, picksClose: iso(r.picksClose), lockTime: iso(r.lockTime), status: rounds.statusOf(r), sealed, encoding: LEAF_ENCODING,
      leafFormat: 'keccak256(bytes.concat(keccak256(abi.encode(round, picker, slot, side, spreadBp, signedAt))))',
      typedData: { domain: { name: 'TAPEWARD', version: '1', chainId: CHAIN_ID }, primaryType: 'Pick', types: { Pick: [{ name: 'round', type: 'bytes32' }, { name: 'side', type: 'uint8' }, { name: 'spreadBp', type: 'int32' }, { name: 'slot', type: 'uint8' }, { name: 'signedAt', type: 'uint64' }] } },
      anchors: as.map((x) => ({ n: x.n, root: x.root, count: x.count, tx: x.tx, link: txLink(x.tx), final: x.final })),
      pending: store.pickCount(id).picks - (a ? a.count : 0) }
    if (!a) return { ...base, root: null, count: 0, anchor: null, leaves: [], ...(sealed ? { note: 'picks stay sealed until picks close: only leaf fingerprints and inclusion proofs are public' } : {}) }
    const vals = anchorLeaves(a).map((p) => ({ ...p, roundHex: roundHex(r.id) }))
    const tree = buildTree(vals)
    const proofs = proofsOf(tree)
    const deskAddr = r.desk?.address
    const leaves = vals.map((p) => sealed ? { leaf: p.leaf, proof: proofs.get(p.leaf) }
      : { picker: p.picker, slot: p.slot, side: p.side, sideName: sideName(p.side), spreadBp: p.spreadBp, signedAt: p.signedAt, leaf: p.leaf, proof: proofs.get(p.leaf), signature: p.signature, desk: deskAddr && p.picker === deskAddr ? rules().house_desk.name : null })
    return { ...base, root: tree.root, count: vals.length, anchor: anchorView(a), leaves, ...(sealed ? { note: 'picks stay sealed until picks close: only leaf fingerprints and inclusion proofs are public' } : {}) }
  }

  // ───────────────────────────── board
  /** official set = final (else last) confirmed anchor; score = settled result idx (official) or live spread (unofficial) */
  async function board(id, idx = null) {
    const r = store.getRound(id)
    if (!r) return null
    const i = idx == null ? (r.kind === 'election' ? rules().election.board_score_index : 0) : Number(idx)
    const res = store.resultsOf(r.id).find((x) => x.idx === i && okStatus(x.status))
    const as = okAnchors(r.id)
    const a = as.filter((x) => x.final).pop() || as.at(-1)
    const now = clock()
    const base = { round: r.id, label: r.label, status: rounds.statusOf(r), scoreIndex: i, scoreLabel: r.scoreLabels[i], computedBy: 'server/score.mjs (same code as verify.mjs)', verify: `node verify.mjs --round ${r.id}` }
    if (now < r.picksClose || !a) return { ...base, official: false, result: null, count: a ? a.count : 0, rows: [], note: now < r.picksClose ? 'picks stay sealed until picks close' : 'no picks recorded on chain yet' }
    let actual = null, official = false, result = null
    if (res) { actual = res.spreadBp; official = true; result = { redBp: res.redBp, blueBp: res.blueBp, refBp: res.refBp, spreadBp: res.spreadBp, tx: res.tx, link: txLink(res.tx), at: iso(res.at) } }
    else if (now >= r.lockTime) {
      const lr = await oracle.race(r.lockTime, r.scoreTimes[i]).catch(() => null)
      if (lr) { actual = lr.spreadBp; result = { redBp: lr.red.bp, blueBp: lr.blue.bp, refBp: lr.ref.bp, spreadBp: lr.spreadBp, live: true, note: 'live, unofficial' } }
    }
    const vals = anchorLeaves(a).filter((p) => !(store.getPick(r.id, p.picker, p.slot)?.void))
    const desks = store.desks()
    const deskAddr = r.desk?.address?.toLowerCase()
    const pays = prizes && official ? new Map(store.payoutsOf(r.id).map((p) => [p.address, p])) : new Map()
    const rows = rankBoard(vals, actual).map((x) => ({
      rank: x.rank, address: x.picker, desk: x.picker.toLowerCase() === deskAddr ? rules().house_desk.name : desks.get(x.picker.toLowerCase()) || null, house: x.picker.toLowerCase() === deskAddr,
      side: sideName(x.best.side), spreadBp: x.best.spreadBp, slot: x.best.slot, signedAt: iso(x.best.signedAt * 1000), score: x.best.score, sideRight: x.best.sideRight, distance: x.best.distance,
      slots: x.slots.map((s) => ({ ...s, side: sideName(s.side), signedAt: iso(s.signedAt * 1000) })), card: `/api/card/${r.id}/${x.picker}.png`, share: `/r/${r.id}/${x.picker}`,
      prize: pays.has(x.picker) ? (({ usd, symbol, amount, status, tx, link, place = pays.get(x.picker).rank }) => ({ place, usd, symbol, amount, status, tx, link }))(prizes.wonBy(x.picker).find((p) => p.round === r.id)) : null,
    }))
    let aftershock = null
    if (r.kind === 'election' && i === 0) {
      const r1 = store.resultsOf(r.id).find((x) => x.idx === 1 && okStatus(x.status))
      if (r1) aftershock = { label: r.scoreLabels[1], redBp: r1.redBp, blueBp: r1.blueBp, refBp: r1.refBp, spreadBp: r1.spreadBp, tx: r1.tx, link: txLink(r1.tx),
        rows: rankBoard(vals, r1.spreadBp).map((x) => ({ rank: x.rank, address: x.picker, score: x.best.score })) }
    }
    return { ...base, official, result, aftershock, anchor: anchorView(a), count: rows.length, rows }
  }

  // ───────────────────────────── wallet
  async function wallet(address) {
    const addr = getAddress(address)
    const h = await holder.status(addr)
    const desks = store.desks()
    const out = []
    const boards = new Map()
    for (const p of store.picksOfPicker(addr)) {
      const r = store.getRound(p.round)
      if (!r) continue
      const as = okAnchors(r.id)
      const first = as.find((a) => a.leaves.includes(p.leaf))
      const lastA = as.filter((a) => a.final).pop() || as.at(-1)
      const inFinal = !!lastA && lastA.leaves.includes(p.leaf)
      let score = null, rank = null, of = null
      if (inFinal && clock() >= r.picksClose) {
        if (!boards.has(r.id)) boards.set(r.id, await board(r.id))
        const b = boards.get(r.id)
        const row = b?.rows.find((x) => x.address === addr)
        const sl = row?.slots.find((s) => s.slot === p.slot)
        if (b?.official && sl) { score = sl.score; rank = row.slot === p.slot ? row.rank : null; of = b.count }
      }
      out.push({ round: r.id, label: r.label, slot: p.slot, ...(isSealed(r) ? { sealed: true } : { side: sideName(p.side), spreadBp: p.spreadBp }), signedAt: iso(p.signedAt * 1000), leaf: p.leaf, void: p.void || null,
        status: p.void ? 'void' : score != null ? 'scored' : inFinal ? (clock() < r.lockTime ? 'anchored' : 'locked') : first ? 'replaced-or-pending' : 'pending',
        anchored: first ? { n: first.n, root: first.root, tx: first.tx, link: txLink(first.tx) } : null,
        final: inFinal && lastA.final ? { n: lastA.n, root: lastA.root, tx: lastA.tx, link: txLink(lastA.tx) } : null,
        score, rank, of, nextAnchorAt: first ? null : nextAnchorAt(r), card: `/api/card/${r.id}/${addr}.png`, share: `/r/${r.id}/${addr}` })
    }
    // a pick that was replaced before an anchor shows only the newest version; status "pending" until the next anchor
    for (const x of out) if (x.status === 'replaced-or-pending') x.status = 'pending'
    const slots = {}
    for (const r of store.rounds().filter((r) => clock() < r.picksClose)) slots[r.id] = slotsFor(r, h, rules(), token())
    const scored = out.filter((x) => x.score != null)
    const won = prizes ? prizes.wonBy(addr) : []
    return { address: addr, desk: desks.get(addr.toLowerCase()) || null, holder: h, slots, picks: out, won,
      totals: { wonUsd: Math.round(won.filter((p) => p.status === 'confirmed' || p.status === 'mock').reduce((s2, p) => s2 + p.usd, 0) * 100) / 100, rounds: new Set(out.map((x) => x.round)).size, points: Math.round(scored.reduce((s, x) => s + x.score, 0) * 10) / 10, best: scored.length ? Math.min(...scored.filter((x) => x.rank).map((x) => x.rank)) : null } }
  }

  // ───────────────────────────── proof
  const METHOD = { openRound: 'openRound', anchor: 'anchor', settle: 'settle', snapshot: 'postSnapshot' }
  let selectors = null
  const selectorOf = (name) => {
    if (!selectors) { selectors = {}; for (const f of racebookAbi().filter((x) => x.type === 'function')) selectors[f.name] = toFunctionSelector(f) }
    return selectors[name] || null
  }
  async function proof() {
    const rb = racebookConfig().address
    const ev = []
    for (const r of store.rounds()) {
      if (r.openTx) ev.push({ type: 'openRound', round: r.id, at: iso(r.openAt), tx: r.openTx, link: txLink(r.openTx), status: r.openStatus })
      for (const a of store.anchorsOf(r.id).filter((x) => okStatus(x.status))) ev.push({ type: 'anchor', round: r.id, n: a.n, at: iso(a.at), tx: a.tx, link: txLink(a.tx), root: a.root, count: a.count, final: a.final })
      for (const x of store.resultsOf(r.id).filter((y) => okStatus(y.status))) ev.push({ type: 'settle', round: r.id, index: x.idx, label: r.scoreLabels[x.idx], at: iso(x.at), tx: x.tx, link: txLink(x.tx), redBp: x.redBp, blueBp: x.blueBp, refBp: x.refBp, spreadBp: x.spreadBp })
    }
    for (const s of store.snapshotsPosted(500)) ev.push({ type: 'snapshot', at: iso(s.at), ts: iso(s.ts * 1000), hash: s.hash, tx: s.tx, link: txLink(s.tx), url: `/api/snapshot/${s.hash}` })
    for (const e of ev) { e.method = METHOD[e.type]; e.selector = selectorOf(e.method) }
    ev.sort((a, b) => ((a.at || '') < (b.at || '') ? 1 : -1))
    const byType = {}
    for (const e of ev) byType[e.type] = (byType[e.type] || 0) + 1
    return {
      methods: Object.fromEntries(Object.entries(METHOD).map(([t, m]) => [selectorOf(m), { type: t, method: m }])), byType,
      contract: rb, link: link.address(rb), chainId: CHAIN_ID, mode: book.mode, poster: book.posterAddress() || POSTER, owner: OWNER,
      feeds: feeds().map((f) => ({ symbol: f.symbol, name: f.name, basket: f.basket, proxy: f.proxy, link: link.address(f.proxy), decimals: f.decimals })),
      events: ev,
      verify: { script: 'server/verify.mjs', run: `node verify.mjs --api ${publicUrl()} --round <ROUND>` + (rb ? ` --racebook ${rb}` : ''), needs: 'Node ≥ 22, the npm packages of server/package.json, a Robinhood Chain RPC' },
    }
  }

  return { state, summary, round, picksDoc, board, wallet, proof, deskRecord, raceNow, raceElection }
}
