// Read-only chain smoke test (no keys, no transactions): chain id + latest block, then for each of the 13 feeds in feeds.json
// description() + decimals() + latestRoundData(); when a RaceBook address is known also feeds() order, poster(), roundCount().
// npm run smoke   (exit 1 if anything is off)
import { createPublicClient, http, parseAbi, getAddress } from 'viem'
import { FEED_ABI } from './chain.mjs'
import { feeds, racebookConfig, CHAIN_ID, PUBLICNODE } from './config.mjs'

const url = process.env.RPC_URL || PUBLICNODE
const c = createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 2 }) })
let bad = 0
const chainId = await c.getChainId()
const block = await c.getBlock()
console.log(`rpc ${url} · chain ${chainId}${chainId === CHAIN_ID ? '' : ' ✗ expected ' + CHAIN_ID} · block ${block.number} @ ${new Date(Number(block.timestamp) * 1000).toISOString()}`)
if (chainId !== CHAIN_ID) bad++
for (const f of feeds()) {
  const read = (functionName) => c.readContract({ address: f.proxy, abi: FEED_ABI, functionName })
  const [desc, dec, r] = await Promise.all([read('description'), read('decimals'), read('latestRoundData')])
  const ok = desc.toUpperCase().includes(f.symbol) && dec === f.decimals && r[1] > 0n
  if (!ok) bad++
  const age = ((Date.now() / 1000 - Number(r[3])) / 3600).toFixed(1)
  console.log(`${ok ? '✓' : '✗'} ${f.basket.padEnd(4)} ${f.symbol.padEnd(4)} "${desc}" dec ${dec} · round ${r[0]} · $${(Number(r[1]) / 10 ** dec).toFixed(4)} · updated ${new Date(Number(r[3]) * 1000).toISOString()} (${age} h ago)`)
}
// prize wallet: ETH/USD feed + each prize token's symbol()/decimals() + its feed
const pz = JSON.parse((await import('node:fs')).readFileSync(new URL('./prizes.json', import.meta.url), 'utf8'))
const e20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'])
{
  const [d, r] = await Promise.all([c.readContract({ address: pz.eth_usd_feed, abi: FEED_ABI, functionName: 'description' }), c.readContract({ address: pz.eth_usd_feed, abi: FEED_ABI, functionName: 'latestRoundData' })])
  const ok = /ETH/.test(d) && r[1] > 0n; if (!ok) bad++
  const eth = await c.getBalance({ address: pz.wallet })
  console.log(`${ok ? '✓' : '✗'} prize wallet ${pz.wallet}: ${Number(eth) / 1e18} ETH · "${d}" $${(Number(r[1]) / 1e8).toFixed(2)} · nonce ${await c.getTransactionCount({ address: pz.wallet })}`)
}
for (const t of pz.tokens) {
  const [sym, dec, bal, fd] = await Promise.all([c.readContract({ address: t.token, abi: e20, functionName: 'symbol' }), c.readContract({ address: t.token, abi: e20, functionName: 'decimals' }),
    c.readContract({ address: t.token, abi: e20, functionName: 'balanceOf', args: [pz.wallet] }), c.readContract({ address: t.feed, abi: FEED_ABI, functionName: 'description' })])
  const ok = sym === t.symbol && dec === t.decimals && fd.toUpperCase().includes(t.symbol); if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} prize token ${t.symbol.padEnd(4)} ${t.token} symbol ${sym} dec ${dec} · feed "${fd}" · wallet holds ${Number(bal) / 10 ** dec}`)
}
const rb = racebookConfig().address
if (rb) {
  const abi = parseAbi(['function feeds() view returns (address[] red, address[] blue, address ref)', 'function poster() view returns (address)', 'function roundCount() view returns (uint256)'])
  const [fs, poster, n] = await Promise.all(['feeds', 'poster', 'roundCount'].map((fn) => c.readContract({ address: rb, abi, functionName: fn })))
  const onchain = [...fs[0], ...fs[1], fs[2]].map((a) => getAddress(a))
  const mine = feeds().map((f) => getAddress(f.proxy))
  const same = onchain.length === mine.length && onchain.every((a, i) => a === mine[i])
  if (!same) bad++
  console.log(`${same ? '✓' : '✗'} RaceBook ${rb}: feeds() ${same ? 'match feeds.json order' : 'DIFFER from feeds.json'} · poster ${poster} · ${n} rounds`)
} else console.log('· RaceBook: no address yet (env RACEBOOK / contracts/deployments/robinhood.json / token.json racebook)')
process.exit(bad ? 1 : 0)
