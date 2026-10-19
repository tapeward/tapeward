// Shared configuration: rules.json, feeds.json, web/token.json (re-read every 30 s), RaceBook address, typed data, ABI, clock.
// Nothing here holds a key (keys: chain.mjs loadPoster, env POSTER_PK).
//
// Env:
//   RULES_JSON / FEEDS_JSON / TOKEN_JSON        override file paths
//   RACEBOOK=0x…                                RaceBook address (else token.json "racebook", else contracts/deployments/robinhood.json)
//   CHAIN_MODE=mock|chain                       mock = RaceBook writes go to SQLite only (default when no RaceBook address)
//   PUBLIC_URL=https://tapeward.live            base for anchor/snapshot URIs
//   FAKE_NOW=2026-10-20T13:25:00Z TIME_SCALE=60 dev clock
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const SERVER_DIR = fileURLToPath(new URL('./', import.meta.url))
export const ZERO = '0x0000000000000000000000000000000000000000'
export const CHAIN_ID = 4663
export const EXPLORER = 'https://explorer.chain.robinhood.com'
export const PUBLICNODE = 'https://robinhood-rpc.publicnode.com'
export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''))
export const isZero = (a) => !isAddr(a) || String(a).toLowerCase() === ZERO

// ───────────────────────────── JSON files cached by mtime, checked at most every 30 s
const files = new Map()
export function readJson(path, { maxAgeMs = 30_000 } = {}) {
  const hit = files.get(path)
  if (hit && Date.now() - hit.checked < maxAgeMs) return hit.value
  let value = hit ? hit.value : null, mtime = 0
  try {
    mtime = statSync(path).mtimeMs
    if (!hit || hit.mtime !== mtime) value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) { if (e.code === 'ENOENT') value = null; else if (!hit) console.error(`config: ${path}: ${e.message}`) }
  files.set(path, { checked: Date.now(), mtime, value })
  return value
}
export function _clearJsonCache() { files.clear() }

export const paths = {
  rules: () => process.env.RULES_JSON || SERVER_DIR + 'rules.json',
  feeds: () => process.env.FEEDS_JSON || SERVER_DIR + 'feeds.json',
  token: () => process.env.TOKEN_JSON || ROOT + 'web/token.json',
  deployment: () => process.env.DEPLOYMENT_JSON || ROOT + 'contracts/deployments/robinhood.json',
  typed: () => process.env.TYPED_DATA_JSON || ROOT + 'contracts/typed-data.json',
  abi: () => process.env.RACEBOOK_ABI_JSON || ROOT + 'contracts/abi/RaceBook.json',
}

/** rules.json (single source of truth for rounds + scoring; deploy copies it to web/rules.json) */
export function rules() {
  const r = readJson(paths.rules())
  if (!r) throw new Error('server/rules.json missing')
  return r
}

/** feeds.json: [{symbol, name, basket: RED|BLUE|REF, proxy, decimals}] in contract order (RED…, BLUE…, REF) */
export function feeds() {
  const f = readJson(paths.feeds()) || { feeds: [] }
  return f.feeds
}
export const basketOf = (b, list = feeds()) => list.filter((f) => f.basket === b)

/** web/token.json (golive.sh rewrites it; picked up within 30 s) */
export function token() {
  return readJson(paths.token()) || { name: 'TAPEWARD', symbol: null, ca: ZERO, holder_min: 0, launch_at: null }
}
export const appName = () => token().name || 'TAPEWARD'
/** holder gate: token live (ca set) and holder_min > 0 */
export const gateOn = (t = token()) => !isZero(t.ca) && Number(t.holder_min) > 0

/** RaceBook address: env RACEBOOK, token.json racebook, contracts/deployments/robinhood.json (several shapes), else null */
export function racebookConfig() {
  if (isAddr(process.env.RACEBOOK) && !isZero(process.env.RACEBOOK)) return { address: process.env.RACEBOOK, fromBlock: Number(process.env.RACEBOOK_FROM_BLOCK || 0) || null, source: 'env RACEBOOK' }
  const t = token()
  const d = readJson(paths.deployment())
  const cands = [d?.RaceBook, d?.raceBook, d?.racebook, d?.contracts?.RaceBook, d]
  for (const c of cands) {
    if (!c) continue
    const addr = typeof c === 'string' ? c : c.address
    if (isAddr(addr) && !isZero(addr)) {
      const fb = Number((typeof c === 'object' && (c.blockNumber ?? c.deployBlock ?? c.startBlock ?? c.block)) ?? d.blockNumber ?? d.deployBlock ?? 0)
      return { address: addr, fromBlock: fb || null, source: 'contracts/deployments/robinhood.json' }
    }
  }
  if (isAddr(t.racebook) && !isZero(t.racebook)) return { address: t.racebook, fromBlock: null, source: 'web/token.json racebook' }
  return { address: null, fromBlock: null, source: null }
}
/** mock unless CHAIN_MODE=chain (or a RaceBook address is known and CHAIN_MODE is not mock) */
export function chainMode() {
  const m = process.env.CHAIN_MODE
  if (m === 'mock' || m === 'chain') return m
  return racebookConfig().address ? 'chain' : 'mock'
}

export const PICK_TYPES_DEFAULT = {
  Pick: [
    { name: 'round', type: 'bytes32' }, { name: 'side', type: 'uint8' }, { name: 'spreadBp', type: 'int32' },
    { name: 'slot', type: 'uint8' }, { name: 'signedAt', type: 'uint64' },
  ],
}
/** EIP-712 spec from contracts/typed-data.json when present, else the BRIEF shape. No verifyingContract (picks can be signed before deploy). */
export function typedSpec() {
  const j = readJson(paths.typed())
  const types = j?.types?.Pick ? { Pick: j.types.Pick } : PICK_TYPES_DEFAULT
  const dom = j?.domain || {}
  const domain = { name: dom.name || 'TAPEWARD', version: dom.version || '1', chainId: Number(dom.chainId || CHAIN_ID) }
  if (isAddr(dom.verifyingContract)) domain.verifyingContract = dom.verifyingContract
  return { domain, types, primaryType: 'Pick' }
}

/** KEY=VALUE lines (export / quotes tolerated) */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export const publicUrl = () => String(process.env.PUBLIC_URL || `https://${token().domain || 'tapeward.live'}`).replace(/\/+$/, '')

// ───────────────────────────── clock (FAKE_NOW / TIME_SCALE for dev)
export function createClock({ fakeNow = process.env.FAKE_NOW, scale = Number(process.env.TIME_SCALE || 1), real = () => Date.now() } = {}) {
  const start = real()
  const base = fakeNow ? Date.parse(fakeNow) : start
  if (fakeNow && !Number.isFinite(base)) throw new Error(`FAKE_NOW is not a date: ${fakeNow}`)
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const fn = () => (fakeNow || s !== 1 ? Math.floor(base + (real() - start) * s) : real())
  fn.fake = !!fakeNow || s !== 1
  fn.scale = s
  fn.real = real
  return fn
}
/** fixed clock for tests (advance with .set / .add) */
export function fixedClock(t) {
  let now = typeof t === 'string' ? Date.parse(t) : t
  const fn = () => now
  fn.set = (x) => { now = typeof x === 'string' ? Date.parse(x) : x }
  fn.add = (ms) => { now += ms }
  fn.fake = true; fn.scale = 1; fn.real = () => now
  return fn
}

export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
export const link = {
  address: (a) => (a ? `${EXPLORER}/address/${a}` : null),
  tx: (h) => (h && /^0x[0-9a-fA-F]{64}$/.test(h) ? `${EXPLORER}/tx/${h}` : null),
  token: (a) => `${EXPLORER}/token/${a}`,
  block: (b) => `${EXPLORER}/block/${b}`,
}
