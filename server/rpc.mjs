// Minimal JSON-RPC client for Robinhood Chain (4663): ordered mirrors, retries, batching.
// Default mirror: robinhood-rpc.publicnode.com (the official *.chain.robinhood.com host is blocked on the lead's ISP; on us1 it can be
// added with RPC_URLS=https://robinhood-rpc.publicnode.com,https://rpc.mainnet.chain.robinhood.com). publicnode refuses wide eth_getLogs
// ranges, so the server never depends on logs: everything it needs comes from views (round, anchorAt, result) and its own DB.
// NO_NETWORK=1 makes every call throw (offline tests).
import { PUBLICNODE } from './config.mjs'

const UA = 'Mozilla/5.0 (compatible; tapeward-server/1.0)'

export function createRpc(urls, { timeoutMs = 20_000, batchMax = 40 } = {}) {
  const URLS = [...urls]
  let id = 0, pref = 0
  async function send(payload) {
    if (process.env.NO_NETWORK === '1') throw new Error('offline (NO_NETWORK=1)')
    const body = JSON.stringify(payload)
    let last
    for (let a = 0; a < Math.max(3, URLS.length * 2); a++) {
      const i = (pref + a) % URLS.length
      try {
        const r = await fetch(URLS[i], { method: 'POST', body, headers: { 'content-type': 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
        if (r.status === 429) { await new Promise((z) => setTimeout(z, 1000 * (a + 1))); throw new Error('HTTP 429') }
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
        const j = JSON.parse(await r.text())
        pref = i
        return j
      } catch (e) {
        last = e
        await new Promise((z) => setTimeout(z, 250 * (a + 1)))
      }
    }
    throw new Error(`rpc: no mirror answered (${last?.message})`)
  }
  async function rpc(method, params = []) {
    const j = await send({ jsonrpc: '2.0', id: ++id, method, params })
    if (j.error) throw Object.assign(new Error(`rpc ${method}: ${j.error.message}`), { rpc: j.error })
    return j.result
  }
  async function batch(calls) {
    const out = []
    for (let k = 0; k < calls.length; k += batchMax) {
      const chunk = calls.slice(k, k + batchMax)
      const payload = chunk.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params || [] }))
      const j = await send(payload)
      const byId = new Map((Array.isArray(j) ? j : [j]).map((x) => [x.id, x]))
      for (const p of payload) {
        const x = byId.get(p.id)
        out.push(!x ? new Error('missing in batch answer') : x.error ? Object.assign(new Error(x.error.message), { rpc: x.error }) : x.result)
      }
    }
    return out
  }
  return { rpc, batch, call: (to, data) => rpc('eth_call', [{ to, data }, 'latest']), urls: URLS }
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
export const rpcUrls = () => (list(process.env.RPC_URLS).length ? list(process.env.RPC_URLS) : [process.env.RPC_URL || PUBLICNODE])
export const reads = createRpc(rpcUrls())
export const hexToBig = (h) => (h && /^0x[0-9a-fA-F]*$/.test(h) && h.length > 2 ? BigInt(h) : 0n)
