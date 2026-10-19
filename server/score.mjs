// Pure scoring + merkle helpers. Shared by the server and verify.mjs (which ships in the public repo), so: no I/O, no config.
//
// basketBp(starts, ends)   equal-weight mean of (end − start) / start in basis points, rounded toward zero (integer math)
// pickScore(pick, actual)  side 100 (sign of actual spread; 0 → nobody) + max(0, 100 − |spreadBp − actual| / 5); returned as
//                          { score, scoreX10 } where scoreX10 is the exact integer (ten times the points)
// rankBoard(picks, actual) best slot per wallet, sorted by score desc, signedAt asc, address asc
// Leaf (OZ StandardMerkleTree): keccak256(bytes.concat(keccak256(abi.encode(round, picker, slot, side, spreadBp, signedAt))))
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { keccak256, encodeAbiParameters } from 'viem'

export const SIDE = { RED: 0, BLUE: 1 }
export const SIDE_NAME = ['RED', 'BLUE']
export const LEAF_ENCODING = ['bytes32', 'address', 'uint8', 'uint8', 'int32', 'uint64']
const LEAF_PARAMS = LEAF_ENCODING.map((type) => ({ type }))
const ONE = 10n ** 18n

/** per-feed return in bp × 1e18 (truncated toward zero) */
export const feedRetX = (start, end) => ((BigInt(end) - BigInt(start)) * 10_000n * ONE) / BigInt(start)
/** per-feed bp (int, toward zero) — display only */
export const feedBp = (start, end) => Number(((BigInt(end) - BigInt(start)) * 10_000n) / BigInt(start))
/** basket bp = trunc( Σ ((end−start)·10⁴·10¹⁸ / start) / (n·10¹⁸) ) */
export function basketBp(starts, ends) {
  if (!starts.length || starts.length !== ends.length) throw new Error('basketBp: bad input')
  let sum = 0n
  for (let i = 0; i < starts.length; i++) sum += feedRetX(starts[i], ends[i])
  return Number(sum / (BigInt(starts.length) * ONE))
}

/** pick {side 0|1 or 'RED'|'BLUE', spreadBp} vs actual spread (bp) */
export function pickScore(pick, actual) {
  if (actual == null) return { score: null, scoreX10: null, sideRight: null, distance: null }
  const side = typeof pick.side === 'string' ? SIDE[pick.side] : Number(pick.side)
  const a = Number(actual)
  const sideRight = a !== 0 && ((a > 0 && side === 0) || (a < 0 && side === 1))
  const d = Math.abs(Number(pick.spreadBp) - a)
  const scoreX10 = (sideRight ? 1000 : 0) + Math.max(0, 1000 - 2 * d)
  return { score: scoreX10 / 10, scoreX10, sideRight, distance: d }
}

/** comparator: higher score first, then earlier signedAt, then lower address */
export const cmpEntry = (a, b) => (b.scoreX10 - a.scoreX10) || (Number(a.signedAt) - Number(b.signedAt)) || (a.picker.toLowerCase() < b.picker.toLowerCase() ? -1 : a.picker.toLowerCase() > b.picker.toLowerCase() ? 1 : 0)

/**
 * picks: [{picker, slot, side, spreadBp, signedAt, ...}] (one per wallet-slot, already valid) · actual: spread bp or null
 * → [{rank, picker, best: {slot, side, spreadBp, signedAt, score}, slots: [...]}]
 */
export function rankBoard(picks, actual) {
  const byWallet = new Map()
  for (const p of picks) {
    const s = pickScore(p, actual)
    const e = { ...p, picker: p.picker, score: s.score, scoreX10: s.scoreX10 ?? 0, sideRight: s.sideRight, distance: s.distance }
    const k = p.picker.toLowerCase()
    if (!byWallet.has(k)) byWallet.set(k, [])
    byWallet.get(k).push(e)
  }
  const rows = []
  for (const list of byWallet.values()) {
    list.sort(cmpEntry)
    rows.push({ ...list[0], slots: list.slice().sort((a, b) => a.slot - b.slot) })
  }
  rows.sort(cmpEntry)
  let rank = 0
  return rows.map((r) => ({ rank: ++rank, picker: r.picker, best: { slot: r.slot, side: r.side, spreadBp: r.spreadBp, signedAt: r.signedAt, score: r.score, sideRight: r.sideRight, distance: r.distance }, slots: r.slots.map((s) => ({ slot: s.slot, side: s.side, spreadBp: s.spreadBp, signedAt: s.signedAt, score: s.score })) }))
}

// ───────────────────────────── merkle
export const leafValues = (p) => [p.roundHex, p.picker, Number(p.slot), Number(p.side), Number(p.spreadBp), BigInt(p.signedAt)]
export const leafHash = (p) => keccak256(keccak256(encodeAbiParameters(LEAF_PARAMS, leafValues(p))))
/** StandardMerkleTree over leaves (OZ sorts them); null for no leaves */
export function buildTree(picks) {
  if (!picks.length) return null
  return StandardMerkleTree.of(picks.map(leafValues), LEAF_ENCODING)
}
/** proofs for every leaf: Map(leafHash → proof[]) */
export function proofsOf(tree) {
  const out = new Map()
  if (!tree) return out
  for (const [i, v] of tree.entries()) out.set(tree.leafHash(v), tree.getProof(i))
  return out
}
export const verifyProof = (root, leaf, proof) => StandardMerkleTree.verify(root, LEAF_ENCODING, leaf, proof)
