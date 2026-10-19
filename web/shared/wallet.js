// Wallet: injected EIP-1193 providers (EIP-6963 discovery + window.ethereum), EIP-712 Pick signature. No gas, no transaction.
// Typed data comes from /shared/typed-data.json (copied from contracts/typed-data.json) with the BRIEF's type as the fallback.
import { CHAIN_ID, clock } from './site.js'

const LS = 'tapeward.addr'
const providers = new Map() // uuid → {info, provider}
let current = null, address = null
try { address = localStorage.getItem(LS) } catch {}
const listeners = new Set()
const emit = () => listeners.forEach((fn) => { try { fn(address) } catch {} })

// late injectors (some wallets set window.ethereum after load)
window.addEventListener('ethereum#initialized', () => emit(), { once: true })
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = e.detail; if (!d?.info?.uuid || !d.provider) return
  providers.set(d.info.uuid, d); emit()
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

export const wallet = {
  get address() { return address },
  get providers() {
    const list = [...providers.values()]
    if (!list.length && window.ethereum) list.push({ info: { uuid: 'injected', name: 'Browser wallet', icon: null, rdns: 'injected' }, provider: window.ethereum })
    return list
  },
  get available() { return providers.size > 0 || !!window.ethereum },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  async connect(uuid) {
    const list = this.providers
    const entry = (uuid && list.find((p) => p.info.uuid === uuid)) || list[0]
    if (!entry) throw Object.assign(new Error('No browser wallet found. Install one (any EIP-1193 wallet) and reload.'), { code: 'no-wallet' })
    current = entry.provider
    const accs = await ask(current, 'eth_requestAccounts')
    if (!accs?.length) throw Object.assign(new Error('The wallet returned no account. Unlock it and try again.'), { code: 'no-account' })
    address = accs?.[0] || null
    try { address ? localStorage.setItem(LS, address) : localStorage.removeItem(LS) } catch {}
    current.on?.('accountsChanged', (a) => { address = a?.[0] || null; try { address ? localStorage.setItem(LS, address) : localStorage.removeItem(LS) } catch {}; emit() })
    emit()
    return address
  },
  // silent reconnect after a reload (eth_accounts never opens a prompt)
  async restore() {
    if (!address || current) return !!current
    for (const { provider } of this.providers) {
      try {
        const accs = await provider.request({ method: 'eth_accounts' })
        if (accs?.some((a) => a.toLowerCase() === address.toLowerCase())) { current = provider; emit(); return true }
      } catch {}
    }
    return false
  },
  forget() { address = null; current = null; try { localStorage.removeItem(LS) } catch {}; emit() },
  get provider() { return current },
}

// ── typed data ────────────────────────────────────────────────────────────────────────────────
const FALLBACK = {
  domain: { name: 'TAPEWARD', version: '1', chainId: CHAIN_ID },
  primaryType: 'Pick',
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
    Pick: [{ name: 'round', type: 'bytes32' }, { name: 'side', type: 'uint8' }, { name: 'spreadBp', type: 'int32' }, { name: 'slot', type: 'uint8' }, { name: 'signedAt', type: 'uint64' }],
  },
}
let spec = null
export async function typedSpec() {
  if (spec) return spec
  try {
    const r = await fetch('/shared/typed-data.json', { cache: 'no-store' })
    if (r.ok) {
      const t = await r.json()
      const types = { ...(t.types || {}) }
      if (!types.EIP712Domain) types.EIP712Domain = Object.keys(t.domain || FALLBACK.domain).map((k) => FALLBACK.types.EIP712Domain.find((f) => f.name === k) || { name: k, type: k === 'verifyingContract' ? 'address' : 'string' })
      spec = { domain: t.domain || FALLBACK.domain, primaryType: t.primaryType || 'Pick', types, roundEncoding: t.roundEncoding || t.roundId || null }
      return spec
    }
  } catch {}
  return (spec = FALLBACK)
}

// round id → bytes32: the server's value when it sends one, else UTF-8 right-padded to 32 bytes
export function roundBytes32(round) {
  if (round?.id32 && /^0x[0-9a-fA-F]{64}$/.test(round.id32)) return round.id32
  const b = new TextEncoder().encode(String(round?.id ?? round))
  if (b.length > 32) throw new Error('round id longer than 32 bytes')
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('').padEnd(64, '0')
}

const hexChain = '0x' + CHAIN_ID.toString(16) // 0x1237
const TIMEOUT = 60_000
const err = (code, message, cause) => Object.assign(new Error(message), { code, cause })
// every wallet call gets a deadline so a wallet that never answers can't leave the panel hanging silently
export function ask(p, method, params, ms = TIMEOUT) {
  let t
  return Promise.race([
    p.request(params ? { method, params } : { method }),
    new Promise((_, rej) => { t = setTimeout(() => rej(err('timeout', `Your wallet did not answer within ${ms / 1000} s. Open the wallet, check for a pending request and try again.`)), ms) }),
  ]).finally(() => clearTimeout(t))
}
const rejected = (e) => e?.code === 4001 || /user rejected|user denied|rejected by user|cancel/i.test(e?.message || '')
const unsupported = (e) => e?.code === -32601 || e?.code === 4200 || /not supported|unsupported|method not found|does not exist/i.test(e?.message || '')

// put the wallet on Robinhood Chain (4663) before signing: many wallets refuse typed data whose domain chainId is not the
// active chain. No transaction is sent. onStep(text) reports progress to the panel.
export async function ensureChain(p, onStep) {
  let cid = null
  try { cid = await ask(p, 'eth_chainId', undefined, 10_000) } catch {}
  if (cid && parseInt(cid, 16) === CHAIN_ID) return 'already'
  onStep?.('Switch your wallet to Robinhood Chain (no transaction)…')
  try { await ask(p, 'wallet_switchEthereumChain', [{ chainId: hexChain }]); return 'switched' } catch (e) {
    if (rejected(e)) throw err('switch-rejected', 'You declined the switch to Robinhood Chain. Your wallet needs it to sign this pick (no transaction, no gas). Press Sign again and approve the switch.', e)
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain|add.*chain/i.test(e?.message || '')) {
      onStep?.('Add Robinhood Chain to your wallet (no transaction)…')
      try {
        await ask(p, 'wallet_addEthereumChain', [{ chainId: hexChain, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://robinhood-rpc.publicnode.com'], blockExplorerUrls: ['https://explorer.chain.robinhood.com'] }])
        try { await ask(p, 'wallet_switchEthereumChain', [{ chainId: hexChain }]) } catch (e2) { if (rejected(e2)) throw e2 }
        return 'added'
      } catch (e2) {
        if (rejected(e2)) throw err('switch-rejected', 'You declined adding Robinhood Chain. Your wallet needs it to sign this pick (no transaction, no gas). Press Sign again and approve it.', e2)
        if (e2?.code === 'timeout') throw e2
        throw err('switch-failed', `Your wallet could not add Robinhood Chain (${e2?.message || 'unknown error'}). Add chain 4663 manually, then sign again.`, e2)
      }
    }
    if (e?.code === 'timeout') throw e
    if (unsupported(e)) return 'unsupported' // wallet has no chain switching: try to sign anyway
    throw err('switch-failed', `Your wallet could not switch to Robinhood Chain (${e?.message || 'unknown error'}).`, e)
  }
}

// message fields as signed; returns {message, signature, typed}
export async function signPick({ round, side, spreadBp, slot = 0, onStep }) {
  if (!current || !address) throw err('no-account', 'Connect a wallet first.')
  const s = await typedSpec()
  const sw = await ensureChain(current, onStep)
  onStep?.('Confirm the signature in your wallet…')
  const message = { round: roundBytes32(round), side: side === 'BLUE' ? 1 : 0, spreadBp: Math.trunc(spreadBp), slot: Number(slot) || 0, signedAt: Math.floor(clock.now() / 1000) }
  const typed = { domain: s.domain, primaryType: s.primaryType, types: s.types, message }
  let signature
  try { signature = await ask(current, 'eth_signTypedData_v4', [address, JSON.stringify(typed)]) } catch (e) {
    if (rejected(e)) throw err('rejected', 'Signature cancelled in the wallet. Nothing was sent.', e)
    if (e?.code === 'timeout') throw e
    if (sw === 'unsupported' && /chain/i.test(e?.message || '')) throw err('chain', 'Your wallet only signs for its active network and cannot switch automatically. Switch it to Robinhood Chain (4663) and sign again.', e)
    if (unsupported(e)) throw err('unsupported', 'This wallet cannot sign typed data (EIP-712). Use another browser wallet.', e)
    throw err('sign-failed', `The wallet could not sign: ${e?.message || 'unknown error'}`, e)
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw err('sign-failed', 'The wallet returned an unexpected signature. Try again or use another wallet.')
  return { message, signature, typed }
}
// wait for wallets to announce themselves (EIP-6963), falling back to window.ethereum after 500 ms
export function walletsReady(ms = 500) {
  if (providers.size) return Promise.resolve(wallet.providers)
  return new Promise((res) => {
    const done = () => { clearTimeout(t); window.removeEventListener('eip6963:announceProvider', on); res(wallet.providers) }
    const on = () => setTimeout(done, 50)
    const t = setTimeout(done, ms)
    window.addEventListener('eip6963:announceProvider', on)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
  })
}
export const isRejection = (e) => e?.code === 4001 || e?.code === 'rejected' || /user rejected|user denied|cancel/i.test(e?.message || '')
