// SQLite store (node:sqlite, WAL). DATA_DIR (default server/data, gitignored) → tapeward.db (CHAIN_MODE=chain) or tapeward-mock.db
// (CHAIN_MODE=mock, so mock rows never mix with real ones); DB=memory or { memory: true } → in-memory.
// Tables: rounds · picks · anchors · results · feed_rounds (Chainlink cache) · history (per-minute prices) · snapshots · desks · kv.
// In CHAIN_MODE=mock the tx columns hold "mock-0x…" ids (never linked to the explorer).
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const J = (s) => (s == null ? null : JSON.parse(s))
const S = (o) => (o == null ? null : JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))

export function openStore({ memory = process.env.DB === 'memory', dir = process.env.DATA_DIR, name = 'tapeward.db' } = {}) {
  let file = ':memory:'
  if (!memory) { const d = dir || fileURLToPath(new URL('./data/', import.meta.url)); mkdirSync(d, { recursive: true }); file = join(d, name) }
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT, day TEXT, opens_at INTEGER NOT NULL,
      picks_close INTEGER NOT NULL, lock_time INTEGER NOT NULL, score_times TEXT NOT NULL, score_labels TEXT NOT NULL, created_at INTEGER NOT NULL,
      open_status TEXT NOT NULL, open_tx TEXT, open_at INTEGER, open_error TEXT, desk TEXT);
    CREATE TABLE IF NOT EXISTS picks (round TEXT NOT NULL, picker TEXT NOT NULL, slot INTEGER NOT NULL, side INTEGER NOT NULL, spread_bp INTEGER NOT NULL,
      signed_at INTEGER NOT NULL, signature TEXT NOT NULL, leaf TEXT NOT NULL, received_at INTEGER NOT NULL, ip TEXT, void TEXT,
      PRIMARY KEY (round, picker, slot));
    CREATE INDEX IF NOT EXISTS picks_picker ON picks(picker);
    CREATE TABLE IF NOT EXISTS pick_log (id INTEGER PRIMARY KEY, round TEXT NOT NULL, picker TEXT NOT NULL, slot INTEGER NOT NULL, side INTEGER NOT NULL,
      spread_bp INTEGER NOT NULL, signed_at INTEGER NOT NULL, signature TEXT NOT NULL, leaf TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS pick_log_leaf ON pick_log(leaf);
    CREATE TABLE IF NOT EXISTS anchors (round TEXT NOT NULL, n INTEGER NOT NULL, root TEXT NOT NULL, count INTEGER NOT NULL, leaves TEXT NOT NULL,
      uri TEXT NOT NULL, final INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, tx TEXT, block INTEGER, at INTEGER NOT NULL, error TEXT,
      PRIMARY KEY (round, n));
    CREATE TABLE IF NOT EXISTS results (round TEXT NOT NULL, idx INTEGER NOT NULL, status TEXT NOT NULL, red_bp INTEGER, blue_bp INTEGER, ref_bp INTEGER,
      spread_bp INTEGER, start TEXT, end_ TEXT, tx TEXT, block INTEGER, at INTEGER, error TEXT, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (round, idx));
    CREATE TABLE IF NOT EXISTS feed_rounds (symbol TEXT NOT NULL, round_id TEXT NOT NULL, answer TEXT NOT NULL, updated_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, round_id));
    CREATE INDEX IF NOT EXISTS feed_rounds_t ON feed_rounds(symbol, updated_at);
    CREATE TABLE IF NOT EXISTS history (minute INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (hash TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'stored',
      tx TEXT, at INTEGER, error TEXT);
    CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots(ts);
    CREATE TABLE IF NOT EXISTS desks (address TEXT PRIMARY KEY, name TEXT NOT NULL, signed_at INTEGER NOT NULL, signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS prize_budgets (round TEXT PRIMARY KEY, value_usd REAL NOT NULL, budget_usd REAL NOT NULL, pct REAL NOT NULL,
      holdings TEXT, at INTEGER NOT NULL, note TEXT);
    CREATE TABLE IF NOT EXISTS payouts (round TEXT NOT NULL, rank INTEGER NOT NULL, address TEXT NOT NULL, score REAL, weight REAL NOT NULL,
      usd REAL NOT NULL, token TEXT, symbol TEXT, amount TEXT, status TEXT NOT NULL, nonce INTEGER, raw TEXT, tx TEXT, block INTEGER, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (round, rank));
    CREATE INDEX IF NOT EXISTS payouts_addr ON payouts(address);
    CREATE TABLE IF NOT EXISTS topups (id TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT, symbol TEXT, amount TEXT NOT NULL, usd REAL, from_addr TEXT,
      tx TEXT, block INTEGER, at INTEGER NOT NULL);
  `)
  const pcols = new Set(db.prepare('PRAGMA table_info(picks)').all().map((c) => c.name))
  if (!pcols.has('nonce')) db.exec('ALTER TABLE picks ADD COLUMN nonce INTEGER')
  const q = (sql) => db.prepare(sql)
  const st = {
    putRound: q(`INSERT OR IGNORE INTO rounds (id, kind, label, day, opens_at, picks_close, lock_time, score_times, score_labels, created_at, open_status, desk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getRound: q('SELECT * FROM rounds WHERE id = ?'),
    allRounds: q('SELECT * FROM rounds ORDER BY lock_time ASC'),
    setOpen: q('UPDATE rounds SET open_status = ?, open_tx = COALESCE(?, open_tx), open_at = COALESCE(?, open_at), open_error = ? WHERE id = ?'),
    setDesk: q('UPDATE rounds SET desk = ? WHERE id = ?'),
    upsertPick: q(`INSERT INTO picks (round, picker, slot, side, spread_bp, signed_at, signature, leaf, received_at, ip, void) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(round, picker, slot) DO UPDATE SET side = excluded.side, spread_bp = excluded.spread_bp, signed_at = excluded.signed_at,
      signature = excluded.signature, leaf = excluded.leaf, received_at = excluded.received_at, ip = excluded.ip, void = NULL`),
    getPick: q('SELECT * FROM picks WHERE round = ? AND picker = ? AND slot = ?'),
    picksOf: q('SELECT * FROM picks WHERE round = ? ORDER BY signed_at ASC, picker ASC, slot ASC'),
    picksOfPicker: q('SELECT * FROM picks WHERE picker = ? ORDER BY signed_at DESC'),
    pickCount: q('SELECT COUNT(*) AS n, COUNT(DISTINCT picker) AS w FROM picks WHERE round = ? AND void IS NULL'),
    totals: q('SELECT COUNT(*) AS n, COUNT(DISTINCT picker) AS w FROM picks WHERE void IS NULL'),
    voidPick: q('UPDATE picks SET void = ? WHERE round = ? AND picker = ? AND slot = ?'),
    logPick: q('INSERT INTO pick_log (round, picker, slot, side, spread_bp, signed_at, signature, leaf, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    pickByLeaf: q('SELECT * FROM pick_log WHERE leaf = ? ORDER BY id ASC LIMIT 1'),
    delAnchor: q('DELETE FROM anchors WHERE round = ? AND n = ?'),
    markFinal: q('UPDATE anchors SET final = 1 WHERE round = ? AND n = ?'),
    putAnchor: q(`INSERT INTO anchors (round, n, root, count, leaves, uri, final, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setAnchor: q('UPDATE anchors SET status = ?, tx = COALESCE(?, tx), block = COALESCE(?, block), error = ? WHERE round = ? AND n = ?'),
    anchorsOf: q('SELECT * FROM anchors WHERE round = ? ORDER BY n ASC'),
    lastAnchor: q('SELECT * FROM anchors WHERE round = ? ORDER BY n DESC LIMIT 1'),
    allAnchors: q('SELECT * FROM anchors ORDER BY at DESC LIMIT ?'),
    anchorCount: q("SELECT COUNT(*) AS n FROM anchors WHERE status IN ('confirmed', 'mock')"),
    lastAnchorAny: q("SELECT * FROM anchors WHERE status IN ('confirmed', 'mock') ORDER BY at DESC LIMIT 1"),
    putResult: q('INSERT OR IGNORE INTO results (round, idx, status) VALUES (?, ?, ?)'),
    setResult: q(`UPDATE results SET status = ?, red_bp = ?, blue_bp = ?, ref_bp = ?, spread_bp = ?, start = COALESCE(?, start), end_ = COALESCE(?, end_),
      tx = COALESCE(?, tx), block = COALESCE(?, block), at = COALESCE(?, at), error = ? WHERE round = ? AND idx = ?`),
    setResultError: q('UPDATE results SET status = ?, error = ?, tries = tries + 1 WHERE round = ? AND idx = ?'),
    resultsOf: q('SELECT * FROM results WHERE round = ? ORDER BY idx ASC'),
    allResults: q("SELECT * FROM results WHERE status IN ('confirmed', 'mock') ORDER BY at DESC LIMIT ?"),
    putFeedRound: q('INSERT OR IGNORE INTO feed_rounds (symbol, round_id, answer, updated_at, seen_at) VALUES (?, ?, ?, ?, ?)'),
    lastFeedRound: q('SELECT * FROM feed_rounds WHERE symbol = ? ORDER BY updated_at DESC, LENGTH(round_id) DESC, round_id DESC LIMIT 1'),
    feedRoundAt: q('SELECT * FROM feed_rounds WHERE symbol = ? AND updated_at <= ? ORDER BY updated_at DESC LIMIT 1'),
    putHistory: q('INSERT OR REPLACE INTO history (minute, data) VALUES (?, ?)'),
    historyRange: q('SELECT * FROM history WHERE minute >= ? AND minute <= ? ORDER BY minute ASC'),
    pruneHistory: q('DELETE FROM history WHERE minute < ?'),
    putSnapshot: q('INSERT OR IGNORE INTO snapshots (hash, ts, json) VALUES (?, ?, ?)'),
    getSnapshot: q('SELECT * FROM snapshots WHERE hash = ?'),
    setSnapshot: q('UPDATE snapshots SET status = ?, tx = COALESCE(?, tx), at = COALESCE(?, at), error = ? WHERE hash = ?'),
    lastSnapshotPost: q("SELECT hash, ts, tx, at, status FROM snapshots WHERE status IN ('confirmed', 'mock') ORDER BY ts DESC LIMIT 1"),
    lastSnapshot: q('SELECT hash, ts, tx, at, status FROM snapshots ORDER BY ts DESC LIMIT 1'),
    pendingSnapshots: q("SELECT hash, ts, status FROM snapshots WHERE status IN ('stored', 'failed') ORDER BY ts DESC LIMIT 3"),
    snapshotsPosted: q("SELECT hash, ts, tx, at, status FROM snapshots WHERE status IN ('confirmed', 'mock') ORDER BY ts DESC LIMIT ?"),
    putDesk: q('INSERT OR REPLACE INTO desks (address, name, signed_at, signature) VALUES (?, ?, ?, ?)'),
    getDesk: q('SELECT * FROM desks WHERE address = ?'),
    allDesks: q('SELECT address, name FROM desks'),
    setNonce: q('UPDATE picks SET nonce = ? WHERE round = ? AND picker = ? AND slot = ?'),
    putBudget: q('INSERT OR IGNORE INTO prize_budgets (round, value_usd, budget_usd, pct, holdings, at, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getBudget: q('SELECT * FROM prize_budgets WHERE round = ?'),
    putPayout: q(`INSERT OR IGNORE INTO payouts (round, rank, address, score, weight, usd, token, symbol, amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setPayout: q(`UPDATE payouts SET status = ?, token = COALESCE(?, token), symbol = COALESCE(?, symbol), amount = COALESCE(?, amount), nonce = COALESCE(?, nonce),
      raw = COALESCE(?, raw), tx = COALESCE(?, tx), block = COALESCE(?, block), error = ?, updated_at = ? WHERE round = ? AND rank = ?`),
    resetPayout: q("UPDATE payouts SET status = 'planned', nonce = NULL, raw = NULL, tx = NULL, error = ?, updated_at = ? WHERE round = ? AND rank = ?"),
    payoutsOf: q('SELECT * FROM payouts WHERE round = ? ORDER BY rank ASC'),
    payoutsOfAddr: q('SELECT * FROM payouts WHERE address = ? ORDER BY created_at DESC'),
    payoutsOpen: q("SELECT * FROM payouts WHERE status IN ('planned', 'signed', 'sent') ORDER BY created_at ASC, rank ASC"),
    payoutsAll: q('SELECT * FROM payouts ORDER BY created_at DESC, rank ASC LIMIT ?'),
    putTopup: q('INSERT OR IGNORE INTO topups (id, kind, token, symbol, amount, usd, from_addr, tx, block, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    topups: q('SELECT * FROM topups ORDER BY at DESC LIMIT ?'),
    getKv: q('SELECT v FROM kv WHERE k = ?'),
    putKv: q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)'),
  }
  const roundRow = (r) => r && ({
    id: r.id, kind: r.kind, label: r.label, day: r.day, opensAt: r.opens_at, picksClose: r.picks_close, lockTime: r.lock_time,
    scoreTimes: J(r.score_times), scoreLabels: J(r.score_labels), createdAt: r.created_at, openStatus: r.open_status, openTx: r.open_tx, openAt: r.open_at,
    openError: r.open_error, desk: J(r.desk),
  })
  const pickRow = (p) => p && ({ round: p.round, picker: p.picker, slot: p.slot, side: p.side, spreadBp: p.spread_bp, signedAt: p.signed_at, signature: p.signature, leaf: p.leaf, receivedAt: p.received_at, void: p.void, nonce: p.nonce ?? null })
  const payoutRow = (r) => r && ({ round: r.round, rank: r.rank, address: r.address, score: r.score, weight: r.weight, usd: r.usd, token: r.token, symbol: r.symbol, amount: r.amount,
    status: r.status, nonce: r.nonce, raw: r.raw, tx: r.tx, block: r.block, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at })
  const anchorRow = (a) => a && ({ round: a.round, n: a.n, root: a.root, count: a.count, leaves: J(a.leaves), uri: a.uri, final: !!a.final, status: a.status, tx: a.tx, block: a.block, at: a.at, error: a.error })
  const resultRow = (r) => r && ({ round: r.round, idx: r.idx, status: r.status, redBp: r.red_bp, blueBp: r.blue_bp, refBp: r.ref_bp, spreadBp: r.spread_bp, start: J(r.start), end: J(r.end_), tx: r.tx, block: r.block, at: r.at, error: r.error, tries: r.tries })
  const frRow = (r) => r && ({ symbol: r.symbol, roundId: r.round_id, answer: r.answer, updatedAt: r.updated_at, seenAt: r.seen_at })

  return {
    db,
    close: () => db.close(),
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } },
    // rounds
    putRound: (r, now) => st.putRound.run(r.id, r.kind, r.label ?? null, r.day ?? null, r.opensAt, r.picksClose, r.lockTime, S(r.scoreTimes), S(r.scoreLabels), now, 'pending', null).changes > 0,
    getRound: (id) => roundRow(st.getRound.get(id)),
    rounds: () => st.allRounds.all().map(roundRow),
    setOpen: (id, status, { tx = null, at = null, error = null } = {}) => st.setOpen.run(status, tx, at, error, id),
    setDesk: (id, desk) => st.setDesk.run(S(desk), id),
    // picks
    upsertPick: (p, now, ip = null) => { st.upsertPick.run(p.round, p.picker, p.slot, p.side, p.spreadBp, p.signedAt, p.signature, p.leaf, now, ip); st.logPick.run(p.round, p.picker, p.slot, p.side, p.spreadBp, p.signedAt, p.signature, p.leaf, now) },
    pickByLeaf: (leaf) => pickRow(st.pickByLeaf.get(leaf)),
    getPick: (round, picker, slot) => pickRow(st.getPick.get(round, picker, slot)),
    picksOf: (round) => st.picksOf.all(round).map(pickRow),
    picksOfPicker: (picker) => st.picksOfPicker.all(picker).map(pickRow),
    pickCount: (round) => { const r = st.pickCount.get(round); return { picks: r.n, wallets: r.w } },
    totals: () => { const r = st.totals.get(); return { picks: r.n, wallets: r.w } },
    voidPick: (round, picker, slot, reason) => st.voidPick.run(reason, round, picker, slot),
    // anchors
    putAnchor: (a) => st.putAnchor.run(a.round, a.n, a.root, a.count, S(a.leaves), a.uri, a.final ? 1 : 0, a.status, a.at),
    setAnchor: (round, n, status, { tx = null, block = null, error = null } = {}) => st.setAnchor.run(status, tx, block, error, round, n),
    deleteAnchor: (round, n) => st.delAnchor.run(round, n),
    markFinal: (round, n) => st.markFinal.run(round, n),
    anchorsOf: (round) => st.anchorsOf.all(round).map(anchorRow),
    lastAnchor: (round) => anchorRow(st.lastAnchor.get(round)),
    recentAnchors: (limit = 100) => st.allAnchors.all(limit).map(anchorRow),
    anchorCount: () => st.anchorCount.get().n,
    lastAnchorAny: () => anchorRow(st.lastAnchorAny.get()),
    // results
    ensureResult: (round, idx) => st.putResult.run(round, idx, 'pending'),
    setResult: (round, idx, r) => st.setResult.run(r.status, r.redBp ?? null, r.blueBp ?? null, r.refBp ?? null, r.spreadBp ?? null, S(r.start), S(r.end), r.tx ?? null, r.block ?? null, r.at ?? null, r.error ?? null, round, idx),
    setResultError: (round, idx, status, error) => st.setResultError.run(status, error, round, idx),
    resultsOf: (round) => st.resultsOf.all(round).map(resultRow),
    recentResults: (limit = 100) => st.allResults.all(limit).map(resultRow),
    // feeds
    putFeedRound: (r, now) => st.putFeedRound.run(r.symbol, r.roundId, r.answer, r.updatedAt, now).changes > 0,
    lastFeedRound: (s) => frRow(st.lastFeedRound.get(s)),
    feedRoundAt: (s, tS) => frRow(st.feedRoundAt.get(s, tS)),
    putHistory: (minute, data) => st.putHistory.run(minute, S(data)),
    history: (fromMin, toMin) => st.historyRange.all(fromMin, toMin).map((r) => ({ minute: r.minute, data: J(r.data) })),
    pruneHistory: (beforeMin) => st.pruneHistory.run(beforeMin),
    // snapshots
    putSnapshot: (s) => st.putSnapshot.run(s.hash, s.ts, s.json).changes > 0,
    getSnapshot: (hash) => st.getSnapshot.get(hash) || null,
    setSnapshot: (hash, status, { tx = null, at = null, error = null } = {}) => st.setSnapshot.run(status, tx, at, error, hash),
    lastSnapshotPost: () => st.lastSnapshotPost.get() || null,
    lastSnapshot: () => st.lastSnapshot.get() || null,
    pendingSnapshots: () => st.pendingSnapshots.all(),
    snapshotsPosted: (limit = 100) => st.snapshotsPosted.all(limit),
    // desks
    putDesk: (d) => st.putDesk.run(d.address, d.name, d.signedAt, d.signature),
    getDesk: (a) => st.getDesk.get(a) || null,
    desks: () => new Map(st.allDesks.all().map((d) => [d.address.toLowerCase(), d.name])),
    // prizes
    setNonce: (round, picker, slot, nonce) => st.setNonce.run(nonce, round, picker, slot),
    putBudget: (b) => st.putBudget.run(b.round, b.valueUsd, b.budgetUsd, b.pct, S(b.holdings), b.at, b.note ?? null).changes > 0,
    getBudget: (round) => { const r = st.getBudget.get(round); return r && { round: r.round, valueUsd: r.value_usd, budgetUsd: r.budget_usd, pct: r.pct, holdings: J(r.holdings), at: r.at, note: r.note } },
    putPayout: (p, now) => st.putPayout.run(p.round, p.rank, p.address, p.score ?? null, p.weight, p.usd, p.token ?? null, p.symbol ?? null, p.amount ?? null, p.status, now, now).changes > 0,
    setPayout: (round, rank, status, f = {}, now) => st.setPayout.run(status, f.token ?? null, f.symbol ?? null, f.amount ?? null, f.nonce ?? null, f.raw ?? null, f.tx ?? null, f.block ?? null, f.error ?? null, now, round, rank),
    resetPayout: (round, rank, error, now) => st.resetPayout.run(error, now, round, rank),
    payoutsOf: (round) => st.payoutsOf.all(round).map(payoutRow),
    payoutsOfAddr: (a) => st.payoutsOfAddr.all(a).map(payoutRow),
    payoutsOpen: () => st.payoutsOpen.all().map(payoutRow),
    payouts: (limit = 500) => st.payoutsAll.all(limit).map(payoutRow),
    putTopup: (t) => st.putTopup.run(t.id, t.kind, t.token ?? null, t.symbol ?? null, String(t.amount), t.usd ?? null, t.from ?? null, t.tx ?? null, t.block ?? null, t.at).changes > 0,
    topups: (limit = 200) => st.topups.all(limit).map((r) => ({ id: r.id, kind: r.kind, token: r.token, symbol: r.symbol, amount: r.amount, usd: r.usd, from: r.from_addr, tx: r.tx, block: r.block, at: r.at })),
    kv: (k) => { const r = st.getKv.get(k); return r ? J(r.v) : null },
    setKv: (k, v) => st.putKv.run(k, S(v)),
  }
}
