#!/usr/bin/env node
// TAPEWARD verify: recompute a round's board from public data only — the published picks (leaves + signatures) and RaceBook on
// Robinhood Chain. It trusts nothing else from the server.
//
//   node verify.mjs --round D-2026-10-20 [--picks URL] [--racebook 0x…] [--rpc URL] [--json]
//     --picks     default https://tapeward.live/api/round/<round>/picks (the `uri` anchored on chain)
//     --racebook  default: the `contract` field of the picks document (checked against chain answers)
//     --rpc       default https://robinhood-rpc.publicnode.com
//   needs: Node ≥ 22, `npm i viem @openzeppelin/merkle-tree` (or run inside server/), and ./score.mjs next to this file.
//
// Checks, in order:
//   1. RaceBook.round(id): the round exists; its last anchored root + count.
//   2. Every leaf: EIP-712 signature (domain {name:"TAPEWARD", version:"1", chainId:4663}, Pick(bytes32 round,uint8 side,int32 spreadBp,
//      uint8 slot,uint64 signedAt)) recovers to the picker; signedAt < picksClose; spread in [-2000, 2000]; side agrees with its sign;
//      one leaf per (picker, slot).
//   3. The rebuilt OpenZeppelin StandardMerkleTree root equals the root anchored on chain (anchorAt(id, n) for the published n).
//   4. RaceBook.result(id, i) for each score time: recompute redBp / blueBp / refBp from the stored Chainlink answers with the contract
//      math (also cross-checked with getRoundData on each feed), then score every pick and rank (best slot per wallet; ties: earlier
//      signedAt, then lower address).
// Exit code 0 = everything matches.
import { createPublicClient, http, recoverTypedDataAddress, getAddress, parseAbi, stringToHex } from 'viem'
import { buildTree, rankBoard, basketBp, leafHash } from './score.mjs'

export const DOMAIN = { name: 'TAPEWARD', version: '1', chainId: 4663 }
export const TYPES = { Pick: [{ name: 'round', type: 'bytes32' }, { name: 'side', type: 'uint8' }, { name: 'spreadBp', type: 'int32' }, { name: 'slot', type: 'uint8' }, { name: 'signedAt', type: 'uint64' }] }
const POINT = '(uint80 roundId, uint48 updatedAt, int128 answer)'
export const ABI = parseAbi([
  `function round(bytes32 id) view returns ((bool exists, uint64 picksClose, uint64 lockTime, uint64 openedAt, uint64[] scoreTimes, uint32 anchorCount, bytes32 root, uint32 count, uint64 lastAnchorAt, bool startSet, bool[] settled))`,
  'function anchorAt(bytes32 id, uint32 n) view returns ((bytes32 root, uint32 count, uint64 at))',
  `function result(bytes32 id, uint8 scoreIndex) view returns ((bool settled, uint64 scoreTime, uint64 settledAt, int64 redBp, int64 blueBp, int64 refBp, int64 spreadBp, ${POINT}[13] start, ${POINT}[13] end))`,
  'function feeds() view returns (address[] red, address[] blue, address ref)',
])
const FEED = parseAbi(['function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)'])

/** core (injectable for tests): { fetchJson(url), read({functionName, args, address?, abi?}) } → report */
export async function verifyRound({ round, picksUrl, racebook, fetchJson, read, checkFeeds = true, log = () => {} }) {
  const errors = []
  const id = stringToHex(round, { size: 32 })
  const doc = await fetchJson(picksUrl)
  if (doc.round !== round) errors.push(`picks document is for ${doc.round}, not ${round}`)
  if (doc.sealed) errors.push('picks are still sealed (picks have not closed yet): only inclusion proofs can be checked now')
  const book = racebook || doc.contract
  if (!book) throw new Error('no RaceBook address (pass --racebook)')
  const r = await read({ address: book, functionName: 'round', args: [id] })
  if (!r.exists) throw new Error(`round ${round} does not exist on RaceBook ${book}`)
  log(`round ${round} on ${book}: ${r.anchorCount} anchors, last root ${r.root} (${r.count} leaves), picksClose ${new Date(Number(r.picksClose) * 1000).toISOString()}`)
  if (doc.sealed) {
    log(`picks are sealed until ${new Date(Number(r.picksClose) * 1000).toISOString()}; run this again after that to recompute the board`)
    return { ok: false, sealed: true, errors, round, racebook: book, root: r.root, anchor: Number(r.anchorCount), leaves: Number(r.count), results: [] }
  }
  // 2. leaves
  const leaves = [], seen = new Set()
  for (const l of doc.leaves || []) {
    const p = { roundHex: id, picker: getAddress(l.picker), slot: Number(l.slot), side: Number(l.side), spreadBp: Number(l.spreadBp), signedAt: Number(l.signedAt) }
    const who = await recoverTypedDataAddress({ domain: DOMAIN, types: TYPES, primaryType: 'Pick', message: { round: id, side: p.side, spreadBp: p.spreadBp, slot: p.slot, signedAt: BigInt(p.signedAt) }, signature: l.signature }).catch(() => null)
    const bad = []
    if (!who || getAddress(who) !== p.picker) bad.push('signature does not recover to picker')
    if (p.signedAt >= Number(r.picksClose)) bad.push('signed after picks close')
    if (p.spreadBp < -2000 || p.spreadBp > 2000) bad.push('spread out of range')
    if ((p.side === 0 && p.spreadBp < 0) || (p.side === 1 && p.spreadBp > 0) || (p.side !== 0 && p.side !== 1)) bad.push('side/sign mismatch')
    const k = p.picker + ':' + p.slot
    if (seen.has(k)) bad.push('duplicate (picker, slot)')
    seen.add(k)
    if (l.leaf && l.leaf !== leafHash(p)) bad.push('leaf hash mismatch')
    if (bad.length) errors.push(`${p.picker} slot ${p.slot}: ${bad.join(', ')}`)
    leaves.push(p)
  }
  // 3. root
  const tree = buildTree(leaves)
  const n = Number(doc.anchor?.n ?? r.anchorCount)
  const a = n ? await read({ address: book, functionName: 'anchorAt', args: [id, n] }) : null
  const root = tree?.root ?? null
  if (!a || !root || a.root.toLowerCase() !== root.toLowerCase()) errors.push(`rebuilt root ${root} ≠ anchored root #${n} ${a?.root}`)
  if (a && Number(a.count) !== leaves.length) errors.push(`anchored count ${a.count} ≠ ${leaves.length} leaves`)
  if (n !== Number(r.anchorCount)) log(`note: verifying anchor #${n}; the last anchor on chain is #${r.anchorCount}`)
  log(`root #${n} ${root} ${errors.some((e) => e.startsWith('rebuilt')) ? '✗' : '✓'} (${leaves.length} leaves)`)
  // 4. results + board
  let feeds = null
  if (checkFeeds) { const f = await read({ address: book, functionName: 'feeds', args: [] }); feeds = [...f[0] ?? f.red, ...f[1] ?? f.blue, f[2] ?? f.ref] }
  const results = []
  for (let i = 0; i < r.scoreTimes.length; i++) {
    const x = await read({ address: book, functionName: 'result', args: [id, i] })
    if (!x.settled) { results.push({ index: i, settled: false, board: null }); continue }
    const s = x.start.map((p) => p.answer), e = x.end.map((p) => p.answer)
    const redBp = basketBp(s.slice(0, 6), e.slice(0, 6)), blueBp = basketBp(s.slice(6, 12), e.slice(6, 12)), refBp = basketBp([s[12]], [e[12]])
    if (redBp !== Number(x.redBp) || blueBp !== Number(x.blueBp) || refBp !== Number(x.refBp) || redBp - blueBp !== Number(x.spreadBp)) errors.push(`result ${i}: stored bps do not match the recomputed ones`)
    if (feeds) {
      for (let k = 0; k < 13; k++) {
        for (const [pt, label] of [[x.start[k], 'start'], [x.end[k], 'end']]) {
          const g = await read({ address: feeds[k], abi: FEED, functionName: 'getRoundData', args: [pt.roundId] })
          if (BigInt(g[1]) !== BigInt(pt.answer) || BigInt(g[3]) !== BigInt(pt.updatedAt)) errors.push(`result ${i}: feed ${k} ${label} round ${pt.roundId} does not match getRoundData`)
        }
      }
    }
    const board = rankBoard(leaves, Number(x.spreadBp))
    results.push({ index: i, settled: true, redBp, blueBp, refBp, spreadBp: Number(x.spreadBp), board })
    log(`result ${i}: RED ${redBp} bp · BLUE ${blueBp} bp · SPY ${refBp} bp · spread ${Number(x.spreadBp)} bp`)
  }
  return { ok: errors.length === 0, errors, round, racebook: book, root, anchor: n, leaves: leaves.length, results }
}

// ───────────────────────────── CLI
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
  const round = arg('round')
  if (!round) { console.error('usage: node verify.mjs --round D-2026-10-20 [--picks URL] [--racebook 0x…] [--rpc URL] [--json]'); process.exit(2) }
  const api = arg('api', 'https://tapeward.live').replace(/\/+$/, '')
  const picksUrl = arg('picks', `${api}/api/round/${round}/picks`)
  const client = createPublicClient({ transport: http(arg('rpc', 'https://robinhood-rpc.publicnode.com'), { timeout: 30_000, retryCount: 3 }) })
  const asJson = process.argv.includes('--json')
  const rep = await verifyRound({
    round, picksUrl, racebook: arg('racebook'),
    fetchJson: async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json() },
    read: ({ address, abi = ABI, functionName, args }) => client.readContract({ address, abi, functionName, args }),
    log: asJson ? () => {} : (m) => console.log(m),
  })
  if (asJson) console.log(JSON.stringify(rep, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  else {
    for (const res of rep.results.filter((x) => x.settled)) {
      console.log(`\nboard (score index ${res.index}, actual spread ${res.spreadBp} bp)`)
      for (const row of res.board.slice(0, 50)) console.log(`${String(row.rank).padStart(4)}  ${row.picker}  ${row.best.side ? 'BLUE' : 'RED '} ${String(row.best.spreadBp).padStart(6)} bp  slot ${row.best.slot}  ${String(row.best.score).padStart(5)} pts`)
    }
    console.log(rep.ok ? '\n✓ everything matches' : `\n✗ ${rep.errors.length} problem(s):\n  ${rep.errors.join('\n  ')}`)
  }
  process.exit(rep.ok ? 0 : 1)
}
