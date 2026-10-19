# TAPEWARD

**Don't call the winner. Call the market.** Two baskets of Robinhood Chain stock tokens race into the US midterms (3 Nov 2026).
RED ("Onshore"): TSLA, SPCX, COIN, PLTR, USO, USAR. BLUE ("Open trade"): TSM, ASML, AAPL, AMZN, BABA, EWY. SPY is the reference line.

- Live: https://tapeward.live
- RaceBook (Robinhood Chain 4663): `0x098cB14018B986bC61C4Ac629088829944E6d924` — source verified on
  [Sourcify](https://repo.sourcify.dev/4663/0x098cB14018B986bC61C4Ac629088829944E6d924)
- Free to play: a pick is an EIP-712 signature (no gas). Picks are recorded on Robinhood Chain before each lock; scores come from the
  Chainlink feeds on Robinhood Chain, and anyone can call `settle`.

## Layout
- `contracts/` — Foundry project: `RaceBook.sol`, tests (incl. a mainnet test against the 13 real feeds), deploy script, ABI, typed data.
  Install deps with `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts` then `forge test`.
- `server/` — Node ≥ 22 (no framework, `node:sqlite`, viem): rounds calendar, Chainlink reader, pick intake (EIP-712), on-chain records,
  settle, scoring, prizes, API. `npm test`. `verify.mjs` recomputes any round's board from Robinhood Chain and the published picks:
  `node server/verify.mjs --round D-2026-10-19`.
- `web/` — static site (ES modules + three.js).

## Disclaimer
Free to enter, no purchase necessary. Prizes are paid from the project's prize wallet, funded by 5 % of creator fees; amounts vary and
can be zero. Not affiliated with Robinhood, Kalshi or any campaign. Baskets are an editorial reading of market commentary, not a political
statement. Stock Tokens are tokenized derivatives tracking a share, not the share itself. 18+. Void where prohibited. Not financial advice.
