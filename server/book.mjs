// RaceBook access: openRound / anchor / settle / postSnapshot (poster key) + views (round, anchorAt, result).
//   CHAIN_MODE=mock  → nothing is sent; the same checks as the contract run locally and rows get "mock-0x…" ids (local dev, tests,
//                      and the time before deploy). Settle math in mock mode uses the real Chainlink rounds read from RC.
//   CHAIN_MODE=chain → viem wallet with the poster key: env POSTER_PK, else /etc/tapeward/poster.env (POSTER_PK=0x…). Every write is
//                      simulated first (contract error names are surfaced), then sent; the receipt is awaited (≤ 120 s).
// The key is never logged and never leaves this module.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, BaseError, ContractFunctionRevertedError, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CHAIN_ID, PUBLICNODE, EXPLORER, readJson, paths, racebookConfig, chainMode, parseEnvFile, feeds as feedList } from './config.mjs'
import { basketBp } from './score.mjs'
import { roundHex } from './calendar.mjs'

export const robinhood = (url) => defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [url] } }, blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } } })

export const SETTLE_DELAY_S = 600
export const MAX_STALENESS_S = 4 * 86400

const FEED_POINT = { type: 'tuple', components: [{ name: 'roundId', type: 'uint80' }, { name: 'updatedAt', type: 'uint48' }, { name: 'answer', type: 'int128' }] }
export const RACEBOOK_ABI_DEFAULT = [
  { type: 'function', name: 'openRound', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'picksClose', type: 'uint64' }, { name: 'lockTime', type: 'uint64' }, { name: 'scoreTimes', type: 'uint64[]' }], outputs: [] },
  { type: 'function', name: 'anchor', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'root', type: 'bytes32' }, { name: 'count', type: 'uint32' }, { name: 'uri', type: 'string' }], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'scoreIndex', type: 'uint8' }, { name: 'startRounds', type: 'uint80[]' }, { name: 'endRounds', type: 'uint80[]' }], outputs: [] },
  { type: 'function', name: 'postSnapshot', stateMutability: 'nonpayable', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'ts', type: 'uint64' }, { name: 'uri', type: 'string' }], outputs: [] },
  { type: 'function', name: 'poster', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'anchorAt', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'n', type: 'uint32' }], outputs: [{ type: 'tuple', components: [{ name: 'root', type: 'bytes32' }, { name: 'count', type: 'uint32' }, { name: 'at', type: 'uint64' }] }] },
  { type: 'function', name: 'round', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'exists', type: 'bool' }, { name: 'picksClose', type: 'uint64' }, { name: 'lockTime', type: 'uint64' }, { name: 'openedAt', type: 'uint64' }, { name: 'scoreTimes', type: 'uint64[]' },
    { name: 'anchorCount', type: 'uint32' }, { name: 'root', type: 'bytes32' }, { name: 'count', type: 'uint32' }, { name: 'lastAnchorAt', type: 'uint64' }, { name: 'startSet', type: 'bool' }, { name: 'settled', type: 'bool[]' }] }] },
  { type: 'function', name: 'result', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'scoreIndex', type: 'uint8' }], outputs: [{ type: 'tuple', components: [
    { name: 'settled', type: 'bool' }, { name: 'scoreTime', type: 'uint64' }, { name: 'settledAt', type: 'uint64' }, { name: 'redBp', type: 'int64' }, { name: 'blueBp', type: 'int64' },
    { name: 'refBp', type: 'int64' }, { name: 'spreadBp', type: 'int64' }, { ...FEED_POINT, name: 'start', type: 'tuple[13]' }, { ...FEED_POINT, name: 'end', type: 'tuple[13]' }] }] },
]
/** RaceBook ABI from contracts/abi/RaceBook.json (array or {abi}) when present, else the BRIEF fragment above */
export function racebookAbi() {
  const j = readJson(paths.abi())
  const abi = Array.isArray(j) ? j : Array.isArray(j?.abi) ? j.abi : null
  return abi && abi.some((x) => x.name === 'anchor') ? abi : RACEBOOK_ABI_DEFAULT
}

let cachedPoster
export function loadPoster(env = process.env) {
  if (cachedPoster !== undefined && env === process.env) return cachedPoster
  let key = env.POSTER_PK || null
  if (!key) { try { key = parseEnvFile(readFileSync(env.POSTER_ENV_FILE || '/etc/tapeward/poster.env', 'utf8')).POSTER_PK || null } catch {} }
  let acct = null
  if (key) {
    const k = key.startsWith('0x') ? key : '0x' + key
    if (/^0x[0-9a-fA-F]{64}$/.test(k)) acct = privateKeyToAccount(k)
    else console.error('book: POSTER_PK is malformed (value not shown)')
  }
  if (env === process.env) cachedPoster = acct
  return acct
}

export const errName = (e) => {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (r?.data?.errorName) return r.data.errorName + (r.data.args?.length ? `(${r.data.args.map(String).join(', ')})` : '')
    return (e.shortMessage || e.message).slice(0, 240)
  }
  return String(e?.message || e).slice(0, 240)
}
class Revert extends Error { constructor(name) { super(name); this.revert = name } }
const mockTx = (...parts) => 'mock-' + keccak256(toHex(parts.join('|')))

export function createBook({ store, chain, clock, log = console, feeds = feedList, mode = chainMode(), account, clients, rpcUrl = process.env.WRITE_RPC_URL || process.env.RPC_URL || PUBLICNODE } = {}) {
  const poster = () => (account === undefined ? loadPoster() : account)
  const address = () => racebookConfig().address
  const isMock = () => mode === 'mock'
  let pub, wallet
  const getPub = () => clients?.pub || (pub ||= createPublicClient({ chain: robinhood(rpcUrl), transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) }))
  const getWallet = () => clients?.wallet || (wallet ||= createWalletClient({ chain: robinhood(rpcUrl), account: poster(), transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }) }))
  const canSend = () => isMock() || (!!address() && !!poster())
  const why = () => (isMock() ? null : !address() ? 'no RaceBook address yet' : !poster() ? 'no poster key (POSTER_PK)' : null)

  async function write(functionName, args) {
    if (!canSend()) throw new Error(why())
    const p = getPub(), w = getWallet()
    let request
    try { ({ request } = await p.simulateContract({ address: address(), abi: racebookAbi(), functionName, args, account: poster() })) } catch (e) { throw Object.assign(new Error(errName(e)), { revert: errName(e) }) }
    const hash = await w.writeContract(request)
    const rc = await p.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }).catch((e) => ({ pendingError: e }))
    if (rc.pendingError) return { status: 'sent', tx: hash }
    if (rc.status !== 'success') throw Object.assign(new Error(`reverted in tx ${hash}`), { tx: hash })
    return { status: 'confirmed', tx: hash, block: Number(rc.blockNumber) }
  }
  const read = (functionName, args = []) => getPub().readContract({ address: address(), abi: racebookAbi(), functionName, args })

  /** contract _checkedPoint for feed k at time tS (throws Revert like the contract) */
  async function checkedPoint(feed, k, roundId, tS) {
    const got = await chain.rounds(feed, [String(roundId), (BigInt(roundId) + 1n).toString()])
    const r = got.get(String(roundId)), next = got.get((BigInt(roundId) + 1n).toString())
    if (!r) throw new Revert(`RoundMissing(${k}, ${roundId})`)
    if (r.updatedAt > tS) throw new Revert(`RoundAfterT(${k}, ${roundId}, ${r.updatedAt}, ${tS})`)
    if (r.updatedAt + MAX_STALENESS_S < tS) throw new Revert(`RoundStale(${k}, ${roundId}, ${r.updatedAt}, ${tS})`)
    if (next && next.updatedAt <= tS) throw new Revert(`RoundNotLatest(${k}, ${roundId}, ${next.updatedAt}, ${tS})`)
    return { symbol: feed.symbol, roundId: String(roundId), updatedAt: r.updatedAt, answer: r.answer }
  }

  return {
    mode, isMock, canSend, why, address, posterAddress: () => (isMock() ? null : poster()?.address || null),

    async openRound(r) {
      const args = [roundHex(r.id), BigInt(Math.floor(r.picksClose / 1000)), BigInt(Math.floor(r.lockTime / 1000)), r.scoreTimes.map((t) => BigInt(Math.floor(t / 1000)))]
      if (isMock()) {
        if (!(r.picksClose < r.lockTime) || r.scoreTimes.some((t, i) => t <= (i ? r.scoreTimes[i - 1] : r.lockTime)) || r.scoreTimes.length > 2) throw new Revert('BadTimes')
        return { status: 'mock', tx: mockTx('openRound', r.id) }
      }
      return write('openRound', args)
    },

    /** anchor root; mock mirrors AnchorAfterLock / CountDecreased / ZeroRoot */
    async anchor(r, root, count, uri, prevCount = 0) {
      if (isMock()) {
        if (clock() > r.lockTime) throw new Revert('AnchorAfterLock')
        if (!/^0x[0-9a-f]{64}$/i.test(root) || /^0x0+$/.test(root)) throw new Revert('ZeroRoot')
        if (count < prevCount) throw new Revert('CountDecreased')
        return { status: 'mock', tx: mockTx('anchor', r.id, root, count) }
      }
      return write('anchor', [roundHex(r.id), root, Number(count), uri])
    },

    /**
     * settle score index `idx`: startRounds (13 ids, or [] once the start is stored) + endRounds (13 ids).
     * Mock: same checks as the contract, result computed with the contract math. Returns { status, tx, result? }.
     */
    async settle(r, idx, startRounds, endRounds, storedStart = null) {
      const T = Math.floor(r.scoreTimes[idx] / 1000), lockS = Math.floor(r.lockTime / 1000)
      const fs = feeds()
      if (isMock()) {
        if (Math.floor(clock() / 1000) < T + SETTLE_DELAY_S) throw new Revert('TooEarly')
        if (endRounds.length !== fs.length) throw new Revert('BadRoundsLength')
        let start = storedStart
        if (!start) {
          if (startRounds.length !== fs.length) throw new Revert('BadRoundsLength')
          start = await Promise.all(fs.map((f, k) => checkedPoint(f, k, startRounds[k], lockS)))
        }
        const end = await Promise.all(fs.map((f, k) => checkedPoint(f, k, endRounds[k], T)))
        const res = computeBps(fs, start, end)
        return { status: 'mock', tx: mockTx('settle', r.id, idx, endRounds.join(',')), result: { ...res, start, end } }
      }
      const out = await write('settle', [roundHex(r.id), idx, startRounds.map(BigInt), endRounds.map(BigInt)])
      let result = null
      if (out.status === 'confirmed') { try { result = await this.readResult(r.id, idx) } catch (e) { log.error?.(`book: result read: ${e.message}`) } }
      return { ...out, result }
    },

    async postSnapshot(hash, tsS, uri) {
      if (isMock()) return { status: 'mock', tx: mockTx('snapshot', hash) }
      return write('postSnapshot', [hash, BigInt(tsS), uri])
    },

    /** on-chain result view → {settled, redBp, blueBp, refBp, spreadBp, start[], end[]} (chain mode) */
    async readResult(id, idx) {
      const v = await read('result', [roundHex(id), idx])
      const fs = feeds()
      const pt = (p, k) => ({ symbol: fs[k]?.symbol, roundId: p.roundId.toString(), updatedAt: Number(p.updatedAt), answer: p.answer.toString() })
      return { settled: v.settled, settledAt: Number(v.settledAt), redBp: Number(v.redBp), blueBp: Number(v.blueBp), refBp: Number(v.refBp), spreadBp: Number(v.spreadBp), start: v.start.map(pt), end: v.end.map(pt) }
    },
    async readRound(id) {
      const v = await read('round', [roundHex(id)])
      return { exists: v.exists, picksClose: Number(v.picksClose), lockTime: Number(v.lockTime), anchorCount: Number(v.anchorCount), root: v.root, count: Number(v.count), startSet: v.startSet, settled: [...v.settled] }
    },
    async onChainPoster() { return isMock() ? null : getAddress(await read('poster')) },
  }
}

/** contract computeBasketBps over FeedPoints in feed order */
export function computeBps(fs, start, end) {
  const idx = (b) => fs.map((f, k) => (f.basket === b ? k : -1)).filter((k) => k >= 0)
  const bp = (b) => { const ks = idx(b); return basketBp(ks.map((k) => start[k].answer), ks.map((k) => end[k].answer)) }
  const redBp = bp('RED'), blueBp = bp('BLUE'), refBp = bp('REF')
  return { redBp, blueBp, refBp, spreadBp: redBp - blueBp }
}
