// Robinhood Chain reads: Chainlink feeds (latestRoundData / getRoundData), ERC-20 balanceOf, and findRoundAt(feed, T) — the round
// that settle() accepts for time T (updatedAt ≤ T and round+1 missing or updatedAt > T). Read-only; RaceBook writes live in book.mjs.
// createChain({ reads }) → helpers. Round answers are immutable, so they are cached in memory.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem'
import { reads as defaultReads, hexToBig } from './rpc.mjs'

export const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
])
export const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'])
const MASK = (1n << 64n) - 1n
/** JSON-RPC error that means the call itself reverted (not a transport/upstream failure) */
export const isRevert = (e) => e?.rpc?.code === 3 || /revert/i.test(String(e?.rpc?.message || e?.message || ''))

export function decodeRound(feed, hex) {
  if (!hex || hex === '0x') return null
  const [roundId, answer, , updatedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: 'latestRoundData', data: hex })
  if (!updatedAt || answer <= 0n) return null
  return { symbol: feed.symbol, roundId: roundId.toString(), answer: answer.toString(), price: Number(answer) / 10 ** (feed.decimals ?? 8), updatedAt: Number(updatedAt) }
}

export function createChain({ reads = defaultReads } = {}) {
  const status = { at: 0, url: reads.urls?.[0] || null, error: null }
  const mark = (e) => { if (e) status.error = e.message; else { status.at = Date.now(); status.error = null } }
  const cache = new Map()   // proxy:roundId → round | null(missing)

  async function latestRounds(feeds) {
    const data = encodeFunctionData({ abi: FEED_ABI, functionName: 'latestRoundData' })
    let res
    try { res = await reads.batch(feeds.map((f) => ({ method: 'eth_call', params: [{ to: f.proxy, data }, 'latest'] }))); mark() } catch (e) { mark(e); throw e }
    return feeds.map((f, i) => (res[i] instanceof Error ? null : decodeRound(f, res[i])))
  }

  /** getRoundData for many ids of one feed (one batch) → Map(id string → round | null) */
  async function rounds(feed, ids) {
    const out = new Map(), need = []
    for (const id of ids.map(String)) { const k = feed.proxy + ':' + id; if (cache.has(k)) out.set(id, cache.get(k)); else need.push(id) }
    if (need.length) {
      let res
      try {
        res = await reads.batch(need.map((id) => ({ method: 'eth_call', params: [{ to: feed.proxy, data: encodeFunctionData({ abi: FEED_ABI, functionName: 'getRoundData', args: [BigInt(id)] }) }, 'latest'] })))
        mark()
      } catch (e) { mark(e); throw e }
      need.forEach((id, i) => {
        const r = res[i]
        // a missing round answers zeros (RC proxies) or reverts; any other RPC error (rate limit, upstream failure) must not be read as
        // "missing", or the search would return a round that settle() rejects (RoundNotLatest)
        if (r instanceof Error && !isRevert(r)) throw r
        const v = r instanceof Error ? null : decodeRound(feed, r)
        const ok = v && v.roundId === id ? v : null
        out.set(id, ok)
        if (ok) cache.set(feed.proxy + ':' + id, ok)   // only existing rounds are cached (immutable)
      })
    }
    return out
  }
  const roundData = async (feed, id) => (await rounds(feed, [id])).get(String(id)) ?? null

  /** last existing aggregator round of phase `phase` (exponential probe up, then binary search) */
  async function lastOfPhase(feed, phase) {
    const base = BigInt(phase) << 64n
    let lo = 0n, hi = 1n
    while (true) {
      const r = await roundData(feed, (base | hi).toString())
      if (!r) break
      lo = hi; hi *= 2n
      if (hi > (1n << 40n)) break
    }
    if (lo === 0n) return null
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n
      if (await roundData(feed, (base | mid).toString())) lo = mid; else hi = mid
    }
    return roundData(feed, (base | lo).toString())
  }

  /**
   * latest round of `feed` with updatedAt ≤ tS (seconds), searched backwards from `top` (default latestRoundData).
   * Exponential probes in one batch, then bracketed searches with 16 probes per batch. Crosses into the previous phase if needed.
   */
  async function findRoundAt(feed, tS, top = null) {
    if (!top) [top] = await latestRounds([feed])
    if (!top) throw new Error(`${feed.symbol}: no latestRoundData`)
    if (top.updatedAt <= tS) return top
    let id = BigInt(top.roundId)
    for (let guard = 0; guard < 4; guard++) {
      const phase = id >> 64n, agg = id & MASK
      // exponential probes below id
      const steps = []
      for (let s = 1n; s < agg; s *= 2n) steps.push(agg - s)
      if (agg > 1n) steps.push(1n)
      const probes = [...new Set(steps.map(String))].map((a) => ((phase << 64n) | BigInt(a)).toString())
      const got = await rounds(feed, probes)
      let hiId = id, loRound = null
      for (const pid of probes) {
        const r = got.get(pid)
        if (r && r.updatedAt <= tS) { loRound = r; break }
        if (r) hiId = BigInt(pid)
      }
      if (!loRound) {
        // whole phase is after tS → previous phase
        if (phase <= 1n) return null
        const last = await lastOfPhase(feed, phase - 1n)
        if (!last) return null
        if (last.updatedAt <= tS) return last
        id = BigInt(last.roundId)
        continue
      }
      // bracket: loRound.updatedAt ≤ tS < round(hiId).updatedAt — narrow with 16 probes per batch
      let lo = BigInt(loRound.roundId), hi = hiId, best = loRound
      while (hi - lo > 1n) {
        const n = hi - lo - 1n < 16n ? hi - lo - 1n : 16n
        const ids = []
        for (let k = 1n; k <= n; k++) ids.push((lo + ((hi - lo) * k) / (n + 1n)).toString())
        const uniq = [...new Set(ids)].filter((x) => BigInt(x) > lo && BigInt(x) < hi)
        if (!uniq.length) break
        const g = await rounds(feed, uniq)
        for (const x of uniq) {
          const r = g.get(x)
          if (r && r.updatedAt <= tS) { lo = BigInt(x); best = r } else { hi = BigInt(x); break }
        }
      }
      return best
    }
    return null
  }

  async function balanceOf(token, holder) {
    try {
      const r = await reads.call(token, encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] }))
      mark()
      return hexToBig(r)
    } catch (e) { mark(e); throw e }
  }
  async function blockNumber() { return Number(hexToBig(await reads.rpc('eth_blockNumber'))) }
  /** ETH + ERC-20 balances of `holder` and the block (one batch) */
  async function holdings(tokens, holder) {
    const calls = [{ method: 'eth_blockNumber' }, { method: 'eth_getBalance', params: [holder, 'latest'] },
      ...tokens.map((t) => ({ method: 'eth_call', params: [{ to: t, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] }) }, 'latest'] }))]
    let res
    try { res = await reads.batch(calls); mark() } catch (e) { mark(e); throw e }
    const bad = res.find((x) => x instanceof Error && !isRevert(x))
    if (bad) throw bad
    return { block: res[0] instanceof Error ? null : Number(hexToBig(res[0])), eth: hexToBig(res[1]), tokens: tokens.map((_, i) => (res[i + 2] instanceof Error ? 0n : hexToBig(res[i + 2]))) }
  }
  async function txCount(addr) { return Number(hexToBig(await reads.rpc('eth_getTransactionCount', [addr, 'latest']))) }

  return { latestRounds, rounds, roundData, findRoundAt, lastOfPhase, balanceOf, blockNumber, holdings, txCount, status, reads }
}
