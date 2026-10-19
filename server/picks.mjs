// POST /api/pick: { pick: { round, side, spreadBp, slot, signedAt }, signature[, address] }
//   round = "D-2026-10-20" or its bytes32 · side 0|1 or "RED"|"BLUE" · spreadBp int [-2000, 2000] matching the side's sign (0 ok)
//   slot 0-based · signedAt unix seconds (± 10 min of server time, before picksClose)
// The picker is the address recovered from the EIP-712 signature (contracts/typed-data.json domain, no verifyingContract).
// One pick per (round, wallet, slot); a newer signature (larger signedAt) replaces the old one until picks close.
// Slots: 1 for everyone; when the holder gate is on, holders get rules.slots.holder_election in ELECTION-2026 (balanceOf at request
// time, re-checked at picks close by the anchor job).
// Desk names: POST /api/desk { address, name, signedAt, signature } with personal_sign of deskMessage(); holders only while the gate is on.
import { recoverTypedDataAddress, verifyMessage, getAddress } from 'viem'
import { typedSpec, rules as rulesOf, gateOn, token as tokenOf, isAddr } from './config.mjs'
import { roundHex, roundFromHex } from './calendar.mjs'
import { leafHash, SIDE } from './score.mjs'

export const typedDataFor = (p, spec = typedSpec()) => ({
  domain: spec.domain, types: spec.types, primaryType: 'Pick',
  message: { round: p.roundHex, side: Number(p.side), spreadBp: Number(p.spreadBp), slot: Number(p.slot), signedAt: BigInt(p.signedAt) },
})
export const deskMessage = (name, address, signedAt) => `TAPEWARD desk name: ${name}\nwallet: ${getAddress(address)}\nsignedAt: ${signedAt}`

/** slots for a wallet in a round given a holder status */
export function slotsFor(round, holder, rules = rulesOf(), t = tokenOf()) {
  const s = rules.slots
  if (!gateOn(t)) return s.default
  if (round.kind === 'election') return holder?.holder ? s.holder_election : s.default
  return holder?.holder ? (s.holder_daily ?? s.default) : s.default
}

const fail = (reason, error, extra = {}) => ({ ok: false, reason, error, ...extra })
const isInt = (x) => Number.isInteger(typeof x === 'string' && /^-?\d+$/.test(x) ? Number(x) : x)

/** parse + validate the shape (no signature, no round lookup) → { pick } | fail */
export function parsePick(body, rules = rulesOf()) {
  const p = body?.pick || body || {}
  let id = p.round, hex
  if (typeof id !== 'string' || !id) return fail('bad_round', 'round missing')
  if (/^0x[0-9a-fA-F]{64}$/.test(id)) { hex = id.toLowerCase(); try { id = roundFromHex(hex) } catch { return fail('bad_round', 'round is not a TAPEWARD round id') } }
  else { if (!/^[A-Z0-9-]{3,31}$/.test(id)) return fail('bad_round', 'unknown round'); hex = roundHex(id) }
  const side = typeof p.side === 'string' && p.side in SIDE ? SIDE[p.side] : Number(p.side)
  if (side !== 0 && side !== 1) return fail('bad_side', 'side must be 0 (RED) or 1 (BLUE)')
  if (!isInt(p.spreadBp)) return fail('bad_spread', 'spreadBp must be an integer')
  const spreadBp = Number(p.spreadBp)
  const pr = rules.pick
  if (spreadBp < pr.spread_bp_min || spreadBp > pr.spread_bp_max) return fail('bad_spread', `spreadBp must be in [${pr.spread_bp_min}, ${pr.spread_bp_max}]`)
  if ((side === 0 && spreadBp < 0) || (side === 1 && spreadBp > 0)) return fail('side_mismatch', 'side must agree with the sign of spreadBp (RED ≥ 0, BLUE ≤ 0)')
  if (!isInt(p.slot) || Number(p.slot) < 0 || Number(p.slot) > 255) return fail('bad_slot', 'slot must be an integer ≥ 0')
  if (!isInt(p.signedAt) || Number(p.signedAt) <= 0) return fail('bad_time', 'signedAt must be unix seconds')
  return { ok: true, pick: { round: id, roundHex: hex, side, spreadBp, slot: Number(p.slot), signedAt: Number(p.signedAt) } }
}

export function createPicks({ store, holder, clock, bus, rules = rulesOf, token = tokenOf, log = console }) {
  const hits = new Map()
  function limited(ip) {
    const now = clock.real(), w = hits.get(ip) || []
    const recent = w.filter((t) => now - t < 60_000)
    recent.push(now); hits.set(ip, recent)
    if (hits.size > 5000) hits.clear()
    return recent.length > 30
  }

  /** full check + store. Returns { ok, replaced, pick, slots, leaf } | { ok:false, reason, error } */
  async function submit(body, { ip = '?', trusted = false } = {}) {
    if (!trusted && limited(ip)) return fail('rate_limited', 'too many picks from this address, wait a minute')
    const R = rules()
    const parsed = parsePick(body, R)
    if (!parsed.ok) return parsed
    const p = parsed.pick
    const r = store.getRound(p.round)
    if (!r) return fail('unknown_round', `no round ${p.round}`)
    const now = clock()
    if (now < r.opensAt) return fail('not_open', `picks for ${r.id} open at ${new Date(r.opensAt).toISOString()}`)
    if (now >= r.picksClose) return fail('closed', `picks for ${r.id} closed at ${new Date(r.picksClose).toISOString()}`)
    const skew = R.pick.signed_at_max_skew_seconds ?? 600
    if (Math.abs(p.signedAt - Math.floor(now / 1000)) > skew) return fail('bad_time', `signedAt is more than ${skew} s away from the server clock (${Math.floor(now / 1000)})`)
    if (p.signedAt * 1000 >= r.picksClose) return fail('closed', 'signedAt is after picks close')
    const sig = String(body?.signature || '')
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return fail('bad_signature', 'signature must be 65 bytes hex')
    let picker
    try { picker = getAddress(await recoverTypedDataAddress({ ...typedDataFor(p), signature: sig })) } catch { return fail('bad_signature', 'signature does not recover') }
    if (body?.address && (!isAddr(body.address) || getAddress(body.address) !== picker)) return fail('bad_signature', 'signature was not made by this address (check the typed data: domain {name, version, chainId} without verifyingContract)')
    // slots
    let h = null
    if (gateOn(token()) && p.slot > 0) h = await holder.status(picker, { fresh: true })
    const max = slotsFor(r, h, R, token())
    if (p.slot >= max) return fail('no_slot', max === 1 ? 'one slot per wallet in this round (slot 0)' : `slots 0..${max - 1} only`, { slots: max, holder: h })
    const old = store.getPick(r.id, picker, p.slot)
    if (old && old.signedAt >= p.signedAt) return fail('stale', 'a newer pick for this slot is already in (signedAt must grow)', { current: { side: old.side, spreadBp: old.spreadBp, signedAt: old.signedAt } })
    const full = { ...p, picker, signature: sig, leaf: leafHash({ ...p, picker }) }
    store.upsertPick(full, now, trusted ? null : ip)
    const used = store.picksOf(r.id).filter((x) => x.picker === picker && !x.void).length
    bus?.emit('pick', { round: r.id, picker, slot: p.slot, replaced: !!old, trusted })
    return { ok: true, replaced: !!old, pick: { round: r.id, roundHex: p.roundHex, picker, slot: p.slot, side: p.side === 0 ? 'RED' : 'BLUE', spreadBp: p.spreadBp, signedAt: p.signedAt, leaf: full.leaf }, slots: { used, max } }
  }

  async function setDesk(body) {
    const { address, name, signedAt, signature } = body || {}
    if (!isAddr(address)) return fail('bad_address', 'address missing')
    const nm = String(name || '').trim()
    if (!/^[A-Za-z0-9 ._-]{3,24}$/.test(nm)) return fail('bad_name', 'desk name: 3–24 letters, digits, space . _ -')
    if (/tapeward/i.test(nm)) return fail('bad_name', 'that name is reserved')
    if (!isInt(signedAt) || Math.abs(Number(signedAt) - Math.floor(clock() / 1000)) > 600) return fail('bad_time', 'signedAt must be within 10 min of now')
    const ok = await verifyMessage({ address: getAddress(address), message: deskMessage(nm, address, signedAt), signature }).catch(() => false)
    if (!ok) return fail('bad_signature', 'signature does not match deskMessage(name, address, signedAt)')
    if (gateOn(token())) { const h = await holder.status(address, { fresh: true }); if (!h.holder) return fail('not_holder', 'desks are for holders', { holder: h }) }
    const prev = store.getDesk(getAddress(address))
    if (prev && prev.signed_at >= Number(signedAt)) return fail('stale', 'a newer desk name is already set')
    store.putDesk({ address: getAddress(address), name: nm, signedAt: Number(signedAt), signature })
    return { ok: true, address: getAddress(address), name: nm }
  }

  return { submit, setDesk }
}
