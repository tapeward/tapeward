# RaceBook

The on-chain record behind TAPEWARD, on Robinhood Chain mainnet (chain id 4663).

Two equal-weight baskets of Robinhood Chain stock-token price feeds race over a round: **RED** (TSLA, SPCX, COIN, PLTR,
USO, USAR) against **BLUE** (TSM, ASML, AAPL, AMZN, BABA, EWY), with SPY as a reference line. Prices come only from
the Chainlink feeds on Robinhood Chain listed in [`feeds.json`](feeds.json). They are fixed in the constructor and
cannot be changed.

- **No funds.** The contract holds no ETH or tokens and pays nothing out. Picks are free EIP-712 signatures;
  scores are points.
- **No upgradeability.** The owner can only change the poster (`setPoster`) and transfer ownership in two steps.
  `renounceOwnership` is disabled.
- **Anyone can settle.** After a score time, anyone can call `settle` with the Chainlink round ids. The
  contract checks them itself and stores the result.

Contract address: `TBD` (written to [`deployments/robinhood.json`](deployments/robinhood.json) at deploy).
ABI: [`abi/RaceBook.json`](abi/RaceBook.json). Pick typed data: [`typed-data.json`](typed-data.json).

## What it does

| Function | Who | What |
|---|---|---|
| `openRound(id, picksClose, lockTime, scoreTimes[])` | poster | New round. `picksClose < lockTime < scoreTimes[0] < scoreTimes[1]`, 1 or 2 score times, unique id. |
| `anchor(id, root, count, uri)` | poster | Merkle root of the signed picks so far. **Reverts after `lockTime`.** `count` never decreases. `uri` is where the leaves and proofs are published. Emits `Anchored(id, n, root, count, uri)`; `n` is the anchor number (1, 2, ...). |
| `settle(id, scoreIndex, startRounds[13], endRounds[13])` | anyone | From `scoreTimes[scoreIndex] + 10 min`. Checks every round id (below), stores per-feed start/end answers and the basket returns. Emits `Settled`. |
| `postSnapshot(hash, ts, uri)` | poster | sha256 of the public reference-odds snapshot (shown as information only, never used for scoring). |
| `setPoster(addr)` | owner | Replace the poster. |

Round id = the round name as UTF-8, right-padded to 32 bytes (`D-2026-10-20`, `ELECTION-2026`;
`cast format-bytes32-string D-2026-10-20`).

Views: `round(id)`, `result(id, i)`, `feeds()`, `anchorAt(id, n)`, `roundCount()` / `roundIdAt(i)`,
`snapshotCount()` / `snapshotAt(n)`, `leafHash(...)`, `verify(id, n, leaf, proof)`, `pickDigest(...)`,
`computeBasketBps(starts, ends)`.

### How settle checks a round id

Feed order everywhere is `red[0..5], blue[0..5], ref` (as in `feeds()` and `feeds.json`). For each feed and time T
(T = `lockTime` for start rounds, T = the score time for end rounds), `getRoundData(roundId)` must:

1. exist (no revert, `updatedAt != 0`, same round id returned) with an answer > 0;
2. have `updatedAt <= T`;
3. be fresh: `updatedAt >= T - 4 days`;
4. be the **latest** one at T: round `roundId + 1` is missing (reverts or `updatedAt == 0`) or has `updatedAt > T`.

So for every feed exactly one round id passes, and nobody can pick a favourable price. Start rounds are checked
and stored on the first settle of a round; a later settle (the second score time) passes `startRounds` empty.
Settle waits 10 minutes after T so that every round with `updatedAt <= T` is already visible.

### The math

```
x_i      = (end_i - start_i) * 1e22 / start_i          // basis points with 18 extra decimals, truncated toward zero
redBp    = (x_0 + ... + x_5) / 6 / 1e18                // each division truncates toward zero
blueBp   = (x_6 + ... + x_11) / 6 / 1e18
refBp    = (end_12 - start_12) * 1e4 / start_12
spreadBp = redBp - blueBp
```

`computeBasketBps` is public, so you can run it on any answers. In JavaScript the same BigInt expressions give the
same numbers (BigInt division also truncates toward zero); see `basketBps` in
[`script/find-rounds.mjs`](script/find-rounds.mjs).

## Verify a settle yourself

1. Read the stored result (start/end round ids, answers, `updatedAt`, and the four bp values):

   ```sh
   RPC=https://robinhood-rpc.publicnode.com
   ID=$(cast format-bytes32-string D-2026-10-20)
   cast call <RaceBook> "round(bytes32)((bool,uint64,uint64,uint64,uint64[],uint32,bytes32,uint32,uint64,bool,bool[]))" $ID --rpc-url $RPC
   cast call <RaceBook> "result(bytes32,uint8)((bool,uint64,uint64,int64,int64,int64,int64,(uint80,uint48,int128)[13],(uint80,uint48,int128)[13]))" $ID 0 --rpc-url $RPC
   ```

2. Find the correct round ids yourself from Chainlink and compare (no dependencies, Node 18+):

   ```sh
   node script/find-rounds.mjs --race <lockTime> <scoreTime>
   ```

   It prints `startRounds`, `endRounds` and `redBp` / `blueBp` / `refBp` / `spreadBp`. Or check one feed by hand:

   ```sh
   cast call <feed> "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" <roundId> --rpc-url $RPC
   cast call <feed> "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" $((<roundId> + 1)) --rpc-url $RPC
   ```

   The first must have `updatedAt` (4th value) `<= T`, the second `> T` or `0`.

## Verify your pick is in a root

Picks are signed with EIP-712, domain `{name: "TAPEWARD", version: "1", chainId: 4663}` (no verifyingContract),
type `Pick(bytes32 round,uint8 side,int32 spreadBp,uint8 slot,uint64 signedAt)` (`side` 0 = RED, 1 = BLUE).
Trees are OpenZeppelin `StandardMerkleTree` with leaf encoding `["bytes32","address","uint8","uint8","int32","uint64"]`:

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(round, picker, slot, side, spreadBp, signedAt))))
```

`picker` is the address that signed. Take your leaf and proof from the `uri` of the anchor, then:

```sh
cast call <RaceBook> "leafHash(bytes32,address,uint8,uint8,int32,uint64)(bytes32)" $ID <you> 0 0 120 <signedAt> --rpc-url $RPC
cast call <RaceBook> "anchorAt(bytes32,uint32)((bytes32,uint32,uint64))" $ID <n> --rpc-url $RPC
cast call <RaceBook> "verify(bytes32,uint32,bytes32,bytes32[])(bool)" $ID <n> <leaf> "[<p0>,<p1>,...]" --rpc-url $RPC
```

`pickDigest(round, side, spreadBp, slot, signedAt)` returns the EIP-712 digest your wallet signed, so you can
`ecrecover` your signature against it. A worked example (digest, signature, leaf) is in
[`typed-data.json`](typed-data.json).

## Events

| Event | topic0 |
|---|---|
| `RoundOpened(bytes32 indexed id, uint64 picksClose, uint64 lockTime, uint64[] scoreTimes)` | `0xb6338043212a1461393181b25ed61bd2cfbbe870bebbe98dfec18c028c28aebb` |
| `Anchored(bytes32 indexed id, uint32 indexed n, bytes32 root, uint32 count, string uri)` | `0x01ac129bc7176c714c3bcaf61564469d3307f149c5d90cd5a5e0f154ffd0672c` |
| `Settled(bytes32 indexed id, uint8 indexed scoreIndex, int64 redBp, int64 blueBp, int64 refBp, int64 spreadBp, address caller)` | `0x04ce8c0a7946544aba9431140ac0428774eb95bb7e08e5308ba83bb785abe38e` |
| `Snapshot(uint32 indexed n, bytes32 indexed hash, uint64 ts, string uri)` | `0xf7aeb6a591823486e272cde2489cd4155bac519308192a4510499a67b32757d0` |
| `PosterChanged(address indexed previousPoster, address indexed newPoster)` | `0x32487a31d5a41d672510a2a1aa50e214e52d5d25fd9a9e94dfa66f4349f8840f` |

Everything an event says is also readable from storage (`round`, `anchorAt`, `result`, `snapshotAt`,
`roundIdAt`), so no log index is needed.

## Build and test

Requires [Foundry](https://getfoundry.sh). OpenZeppelin Contracts v5.4.0 and forge-std are vendored in `lib/`.

```sh
forge build
forge test --no-match-path 'test/fork/*'     # unit tests (mock Chainlink feeds)
forge test --match-path 'test/fork/*' -vv    # mainnet test against the 13 real feeds
forge test --gas-report
```

The mainnet test walks `getRoundData` over JSON-RPC to find the real round ids for a past window (lock 6 h ago,
score 1 h ago), then deploys, opens and settles a RaceBook on mainnet state inside a single `eth_call` (nothing is
sent) and checks the stored result. Env: `FORK_RPC` (default `https://robinhood-rpc.publicnode.com`),
`FORK_LOCK_AGO`, `FORK_SCORE_AGO`, `FORK_STRICT=1` to fail instead of skipping on network errors.

## Deploy

```sh
forge script script/Deploy.s.sol --rpc-url https://robinhood-rpc.publicnode.com --broadcast --private-key <deployer key>
```

`OWNER` / `POSTER` default to the TAPEWARD wallets; feeds come from `feeds.json`. The script refuses zero addresses
and an owner or poster equal to the deployer, checks every feed's `description()`, `decimals()` and freshness on
chain, and writes `deployments/robinhood.json`.

## Verify source (Sourcify)

```sh
forge verify-contract <RaceBook> src/RaceBook.sol:RaceBook --chain 4663 --verifier sourcify \
  --constructor-args $(cast abi-encode "constructor(address,address,address[],address[],address)" \
    0x262336915b1D10f7b071EE555B885ae48E7E6D9a 0x9ed6dB374aEE462fA60432254bace118a90Fe1C9 \
    "[0x4A1166a659A55625345e9515b32adECea5547C38,0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb,0xA3a468A452940B7D6b69991207B508c609a98Ef2,0x820ABedFF239034956B7A9d2F0a331f9F075eB4c,0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c,0xA994d3684e8400A6c8078226925779FdeE682DD9]" \
    "[0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F,0xB4106147E8cce40b7d46124090d373A71b70f87D,0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C,0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984,0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1]" \
    0x319724394D3A0e3669269846abE664Cd621f9f6A)
```

Compiler settings come from `foundry.toml` (solc 0.8.28, optimizer 10000 runs, EVM cancun).
Check: `https://repo.sourcify.dev/4663/<RaceBook>`.

## Known limits

- A Chainlink proxy can move to a new aggregator phase (round ids jump to the next phase prefix). If a round is the
  last of its phase, `roundId + 1` does not exist and the check accepts it, within the 4-day freshness window.
  The round finder only walks the current phase.
- Robinhood Chain stock feeds update on deviation (0.5 %) and a 24 h heartbeat. If a feed did not move enough during
  a round, its end round equals its start round and its return is 0.
