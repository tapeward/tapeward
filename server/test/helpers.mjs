// Test helpers: a fake Robinhood Chain (JSON-RPC level, so the real chain.mjs search code runs), fixed clock, in-memory app.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { FEED_ABI, ERC20_ABI, createChain } from '../chain.mjs'
import { fixedClock } from '../config.mjs'
import { openStore } from '../store.mjs'
import { createTapeward } from '../app.mjs'

process.env.NO_NETWORK = '1'
export const FEEDS = JSON.parse(readFileSync(fileURLToPath(new URL('../feeds.json', import.meta.url)), 'utf8')).feeds
export const RULES = JSON.parse(readFileSync(fileURLToPath(new URL('../rules.json', import.meta.url)), 'utf8'))
export const TYPED = JSON.parse(readFileSync(fileURLToPath(new URL('../../contracts/typed-data.json', import.meta.url)), 'utf8'))
export const quiet = { log() {}, error() {} }
export const acct = (i) => privateKeyToAccount('0x' + (0xabc000 + i).toString(16).padStart(64, '0'))
const PHASE = 1n << 64n

/**
 * Fake feeds: round n of feed k has updatedAt = T0 + n·STEP + k (seconds) and a deterministic answer; rounds exist up to the clock.
 * priceFn(k, n) → answer (BigInt, 8 decimals). balances: { lower(addr) → BigInt } for any ERC-20.
 */
export const PRIZE_CFG = JSON.parse(readFileSync(fileURLToPath(new URL('../prizes.json', import.meta.url)), 'utf8'))
/** extra feeds the prize wallet needs (ETH/USD + tokens whose feed is not in feeds.json): proxy → USD price */
export const EXTRA_PRICES = { [PRIZE_CFG.eth_usd_feed.toLowerCase()]: 2400, '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15': 180 }

export function fakeChain({ clock, T0 = Date.parse('2026-10-01T00:00:00Z') / 1000, STEP = 1800, priceFn, balances = {}, tokenBalances = {}, ethBalances = {}, nonces = {} } = {}) {
  const price = priceFn || ((k, n) => BigInt(100_00000000 + k * 7_00000000) + BigInt(((n * (k + 3)) % 97) - 48) * 10_000_000n)
  const idx = new Map(FEEDS.map((f, k) => [f.proxy.toLowerCase(), k]))
  const lastN = (k) => Math.floor((Math.floor(clock() / 1000) - T0 - k) / STEP)
  const round = (k, n) => [PHASE | BigInt(n), price(k, n), BigInt(T0 + n * STEP + k), BigInt(T0 + n * STEP + k), PHASE | BigInt(n)]
  let calls = 0
  function call({ to, data }) {
    calls++
    const k = idx.get(to.toLowerCase())
    const extra = EXTRA_PRICES[to.toLowerCase()]
    if (extra !== undefined) return encodeFunctionResult({ abi: FEED_ABI, functionName: 'latestRoundData', result: [PHASE | 7n, BigInt(Math.round(extra * 1e8)), BigInt(T0), BigInt(Math.floor(clock() / 1000) - 60), PHASE | 7n] })
    if (k === undefined) {
      const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data })
      if (functionName === 'balanceOf') return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: tokenBalances[to.toLowerCase()]?.[args[0].toLowerCase()] ?? balances[args[0].toLowerCase()] ?? 0n })
      throw Object.assign(new Error('execution reverted'), { rpc: { code: 3 } })
    }
    const { functionName, args } = decodeFunctionData({ abi: FEED_ABI, data })
    if (functionName === 'latestRoundData') return encodeFunctionResult({ abi: FEED_ABI, functionName, result: round(k, lastN(k)) })
    if (functionName === 'getRoundData') {
      const id = args[0], n = Number(id & (PHASE - 1n))
      if (id >> 64n !== 1n || n < 1 || n > lastN(k)) throw Object.assign(new Error('execution reverted'), { rpc: { code: 3 } })
      return encodeFunctionResult({ abi: FEED_ABI, functionName, result: round(k, n) })
    }
    throw Object.assign(new Error('unsupported'), { rpc: { code: 3 } })
  }
  const hex = (n) => '0x' + BigInt(n).toString(16)
  function one(c) {
    if (c.method === 'eth_call') return call(c.params[0])
    if (c.method === 'eth_blockNumber') return hex(1000 + Math.floor(clock() / 1000))
    if (c.method === 'eth_getBalance') return hex(ethBalances[c.params[0].toLowerCase()] ?? 0n)
    if (c.method === 'eth_getTransactionCount') return hex(nonces[c.params[0].toLowerCase()] ?? 0)
    throw new Error(c.method)
  }
  const reads = {
    urls: ['fake'],
    async rpc(method, params) { return one({ method, params }) },
    async batch(cs) { return cs.map((c) => { try { return one(c) } catch (e) { return e } }) },
    async call(to, data) { return call({ to, data }) },
  }
  const chain = createChain({ reads })
  /** the round settle() accepts for T (truth from the model) */
  const truthAt = (k, tS) => Math.floor((tS - T0 - k) / STEP)
  return { chain, reads, price, round, truthAt, T0, STEP, calls: () => calls, balances, tokenBalances, ethBalances, nonces }
}

export const TOKEN = { name: 'TAPEWARD', symbol: null, ca: '0x0000000000000000000000000000000000000000', holder_min: 0, launch_at: '2026-10-21T14:00:00Z', domain: 'tapeward.live' }

export function makeApp({ now = '2026-10-19T13:30:00Z', token = TOKEN, balances, desk = acct(999), chainOpts = {}, prizeOpts = {} } = {}) {
  const clock = fixedClock(now)
  const fc = fakeChain({ clock, balances, ...chainOpts })
  const store = openStore({ memory: true })
  const t = { ...token }
  const app = createTapeward({ store, chain: fc.chain, clock, bus: new EventEmitter(), log: quiet, rules: () => RULES, feeds: () => FEEDS, token: () => t,
    bookOpts: { mode: 'mock' }, kalshiOpts: { mode: 'fixtures' }, deskAccount: desk, prizeOpts: { logs: null, ...prizeOpts } })
  return { ...app, fc, token: t, desk }
}

/** sign a pick with a viem account using contracts/typed-data.json */
export async function signPick(a, p) {
  const { stringToHex } = await import('viem')
  const roundHex = stringToHex(p.round, { size: 32 })
  const msg = { round: roundHex, side: p.side, spreadBp: p.spreadBp, slot: p.slot ?? 0, signedAt: BigInt(p.signedAt) }
  const signature = await a.signTypedData({ domain: TYPED.domain, types: { Pick: TYPED.types.Pick }, primaryType: 'Pick', message: msg })
  return { pick: { round: p.round, side: p.side, spreadBp: p.spreadBp, slot: p.slot ?? 0, signedAt: p.signedAt }, signature, address: a.address }
}
export const nowS = (app) => Math.floor(app.clock() / 1000)
export { encodeAbiParameters }
