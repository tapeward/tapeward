// Holder check: balanceOf(token.json "ca") ≥ holder_min whole tokens (decimals from token.json, default 18), read at request time.
// Skipped (gate off, everyone has the default slots) while ca is the zero address or holder_min is 0. Cached 2 min per wallet.
import { token as tokenOf, gateOn, isAddr } from './config.mjs'

const TTL = 120_000
export function minUnits(t) {
  const dec = Number.isInteger(t.decimals) ? t.decimals : 18
  return (BigInt(Math.round(Number(t.holder_min || 0) * 1e6)) * 10n ** BigInt(dec)) / 1_000_000n
}

export function createHolder({ chain, clock, token = tokenOf }) {
  const cache = new Map()
  async function status(address, { fresh = false } = {}) {
    const t = token()
    if (!gateOn(t)) return { gate: false, holder: null, balance: null, min: Number(t.holder_min || 0) }
    if (!isAddr(address)) return { gate: true, holder: false, error: 'bad address' }
    const k = address.toLowerCase()
    const hit = cache.get(k)
    if (!fresh && hit && clock.real() - hit.at < TTL) return hit.value
    try {
      const bal = await chain.balanceOf(t.ca, address)
      const value = { gate: true, holder: bal >= minUnits(t), balance: bal.toString(), min: Number(t.holder_min), token: t.ca }
      cache.set(k, { at: clock.real(), value })
      return value
    } catch (e) {
      if (hit) return { ...hit.value, stale: true }
      return { gate: true, holder: false, error: 'holder check unavailable', min: Number(t.holder_min) }
    }
  }
  return { status, _set: (a, v) => cache.set(a.toLowerCase(), { at: clock.real(), value: v }) }
}
