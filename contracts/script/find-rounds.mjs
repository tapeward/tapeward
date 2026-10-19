#!/usr/bin/env node
// Find, for each RaceBook feed, the Chainlink round that was the latest one at time T
// (updatedAt <= T and round+1 missing or updatedAt > T), exactly as RaceBook.settle checks it.
// No dependencies (Node >= 18, global fetch). Mirror this logic in the server.
//
// Usage:
//   node script/find-rounds.mjs <T> [<T2> ...]          T = unix seconds or ISO time ("2026-10-20T13:30:00Z")
//   node script/find-rounds.mjs --race <lock> <score>     also prints basket bp exactly as the contract computes them
// Env: RPC (default https://robinhood-rpc.publicnode.com), FEEDS (default ../feeds.json next to this script)
//
// Output: JSON on stdout. `roundIds` is the uint80[13] array for settle (as decimal strings), in feed order
// red[0..5], blue[0..5], ref.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const RPC = process.env.RPC || 'https://robinhood-rpc.publicnode.com';
const FEEDS = process.env.FEEDS || join(dirname(fileURLToPath(import.meta.url)), '..', 'feeds.json');
const MAX_STALENESS = 4n * 86400n;
const SEL_GET_ROUND = '0x9a6fc8f5'; // getRoundData(uint80)
const SEL_LATEST = '0xfeaf968c'; // latestRoundData()

export function loadFeeds(path = FEEDS) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return [...j.red, ...j.blue, j.ref].map((f) => ({ symbol: f.symbol, proxy: f.proxy }));
}

let rpcId = 0;
async function ethCall(to, data, attempt = 0) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) {
    if (attempt < 3) return ethCall(to, data, attempt + 1);
    throw new Error(`rpc http ${res.status}`);
  }
  const j = await res.json();
  if (j.error) {
    if (/revert/i.test(j.error.message || '') || j.error.code === 3) return null; // reverted
    if (attempt < 3) return ethCall(to, data, attempt + 1);
    throw new Error(`rpc error ${JSON.stringify(j.error)}`);
  }
  return j.result;
}

function word(hex, i) {
  return BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
}
function toInt256(x) {
  return x >= 1n << 255n ? x - (1n << 256n) : x;
}
function decodeRound(hex) {
  if (!hex || hex.length < 2 + 64 * 5) return null;
  return { roundId: word(hex, 0), answer: toInt256(word(hex, 1)), updatedAt: word(hex, 3) };
}

/** getRoundData as RaceBook._read sees it: null when it reverts, has updatedAt 0, or returns another id. */
export async function getRound(proxy, roundId) {
  const data = SEL_GET_ROUND + roundId.toString(16).padStart(64, '0');
  const r = decodeRound(await ethCall(proxy, data));
  if (!r || r.updatedAt === 0n || r.roundId !== roundId) return null;
  return r;
}

export async function latestRound(proxy) {
  return decodeRound(await ethCall(proxy, SEL_LATEST));
}

/** Latest round with updatedAt <= t: gallop back from the latest round, then binary search. */
export async function findRound(proxy, t) {
  t = BigInt(t);
  const latest = await latestRound(proxy);
  if (!latest) throw new Error(`latestRoundData failed for ${proxy}`);
  const phaseBase = (latest.roundId >> 64n) << 64n;
  const ok = async (id) => {
    const r = await getRound(proxy, id);
    return r && r.updatedAt <= t ? r : null;
  };
  let hi = latest.roundId; // candidate known to be > t (unless latest itself is <= t)
  if (latest.updatedAt <= t) return finish(proxy, latest, t);
  let step = 1n;
  let lo = null;
  let loRound = null;
  while (true) {
    const id = hi - step;
    if (id <= phaseBase) {
      const first = await ok(phaseBase + 1n);
      if (!first) throw new Error(`no round <= ${t} in the current phase of ${proxy}`);
      lo = phaseBase + 1n;
      loRound = first;
      break;
    }
    const r = await ok(id);
    if (r) {
      lo = id;
      loRound = r;
      break;
    }
    hi = id;
    step *= 2n;
  }
  // invariant: lo has updatedAt <= t, hi has updatedAt > t (or missing)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const r = await ok(mid);
    if (r) {
      lo = mid;
      loRound = r;
    } else hi = mid;
  }
  return finish(proxy, loRound, t);
}

async function finish(proxy, r, t) {
  const next = await getRound(proxy, r.roundId + 1n);
  if (next && next.updatedAt <= t) throw new Error(`walk error on ${proxy}: round ${r.roundId + 1n} is also <= t`);
  if (r.answer <= 0n) throw new Error(`non-positive answer on ${proxy} round ${r.roundId}`);
  const stale = r.updatedAt + MAX_STALENESS < t;
  return { roundId: r.roundId, answer: r.answer, updatedAt: r.updatedAt, nextUpdatedAt: next ? next.updatedAt : null, stale };
}

export async function findRounds(t, feeds = loadFeeds()) {
  const rows = await Promise.all(feeds.map((f) => findRound(f.proxy, t)));
  return feeds.map((f, i) => ({ ...f, ...rows[i] }));
}

/** Same math as RaceBook.computeBasketBps (BigInt division truncates toward zero, like Solidity). */
export function basketBps(starts, ends) {
  const x = (s, e) => ((e - s) * 10n ** 22n) / s;
  let red = 0n;
  let blue = 0n;
  for (let i = 0; i < 6; i++) {
    red += x(starts[i], ends[i]);
    blue += x(starts[6 + i], ends[6 + i]);
  }
  const redBp = red / 6n / 10n ** 18n;
  const blueBp = blue / 6n / 10n ** 18n;
  const refBp = x(starts[12], ends[12]) / 10n ** 18n;
  return { redBp, blueBp, refBp, spreadBp: redBp - blueBp };
}

function parseTime(s) {
  if (/^\d+$/.test(s)) return BigInt(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`bad time ${s}`);
  return BigInt(Math.floor(ms / 1000));
}

const jsonOut = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function main(argv) {
  if (argv.length === 0) {
    console.error('usage: find-rounds.mjs <T> [<T2> ...] | --race <lock> <score>');
    process.exit(2);
  }
  if (argv[0] === '--race') {
    const lock = parseTime(argv[1]);
    const score = parseTime(argv[2]);
    const [s, e] = [await findRounds(lock), await findRounds(score)];
    const bps = basketBps(s.map((r) => r.answer), e.map((r) => r.answer));
    console.log(jsonOut({
      lock, score,
      startRounds: s.map((r) => r.roundId),
      endRounds: e.map((r) => r.roundId),
      ...bps,
      feeds: s.map((r, i) => ({ symbol: r.symbol, start: r, end: e[i] })),
    }));
    return;
  }
  const out = [];
  for (const a of argv) {
    const t = parseTime(a);
    const rows = await findRounds(t);
    out.push({ t, roundIds: rows.map((r) => r.roundId), feeds: rows });
  }
  console.log(jsonOut(out.length === 1 ? out[0] : out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
