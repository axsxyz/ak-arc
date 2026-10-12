# Radar design

Original design requirements for the radar, kept as the reference the code
and tests were written against. Where the implementation has since moved on
(for example the mainnet HTTP-polling mode), the package README and the code
are authoritative.

## Goal

A real-time observer for the Arc chain (Circle L1) that watches liquidity,
tokens, wallets and launchpads continuously and posts precise Discord embeds.
The question it answers: where is USDC liquidity moving fastest?

Priority order: **observe → score → alert → paper-evaluate**. No trading.

## Requirements

- **Exact numbers.** Decimals verified on chain (native USDC is 18-dec, the
  ERC-20 mirror at `0x3600…0000` is 6-dec), supply and reserves read, not
  assumed.
- **Low latency.** The alert path is in-process from ingest; no database on
  the hot path.
- **Deduplication.** The same event within 60 s is one message.
- **Ping discipline.** `@everyone` only in `#alerts`, only for the hard rules
  below. A false `@everyone` is a P0 bug.
- **Config-driven.** Chain id, RPCs, webhooks, watchlists, pad factories and
  thresholds come from env/YAML; testnet → mainnet is a config change.
- **Secrets** are loaded from env only and never committed.

## Network

| Key | Testnet | Mainnet |
|---|---|---|
| Chain ID | `5042002` | `5042` |
| Native gas | USDC, 18 decimals | USDC, 18 decimals |
| ERC-20 USDC mirror | `0x3600000000000000000000000000000000000000` (6 decimals) | same |
| Finality | sub-second; confirmed heads are treated as final | same |

At boot every watchlist contract is checked with `eth_getCode`. Missing
contracts are reported once as `MISSING_ON_CHAIN` (no ping) and skipped;
prices are never invented for them.

## Channels and routing

| Channel | Content |
|---|---|
| `#smart-flow` | Watchlist wallet activity, funding-cluster signals, early-buyer density on new pools |
| `#major-coins` | Watchlist token metrics: periodic digest plus spike updates |
| `#launchpads` | Per-pad launches, graduations/migrations, rolling leaderboard |
| `#alerts` | High-conviction hard rules only; the only channel that may ping |

`#smart-flow` posts when a watchlist wallet buys, sells or adds liquidity;
when a fresh deployer is funded from a notable source (bridge/CCTP); when a
cluster of fresh wallets with one funder hits the same new pool within T
seconds; or when N unique buyers land in the first M blocks of a new pool.
It never relays raw Transfers.

`#major-coins` carries, per watchlist token: price, market cap, volume
1m/5m/1h, LP USDC depth, ΔLP, approximate holders, top-10 share and buy/sell
ratio — or an explicit `n/a`.

`#launchpads` carries, per allowlisted pad and per 1h/24h window: tokens
launched, graduated count and ratio, total volume, median time-to-$X, share
of ecosystem volume; plus launch/graduation events and an hourly leaderboard.

### Hard alert rules (`#alerts`, may ping)

Exactly one primary hard condition fires an alert, with its evidence in the
embed. Thresholds are configurable.

1. **LP_SURGE**: net USDC added to a pool/curve ≥ `ALERT_LP_USD` within
   `ALERT_LP_WINDOW_SEC`.
2. **PAD_MIGRATE_HOT**: a token graduates and post-migration volume ≥
   `ALERT_MIGRATE_VOL_USD` within 5 minutes.
3. **WATCHLIST_WALLET_FAST**: a labeled wallet buys a new token within
   `ALERT_WALLET_AGE_SEC` of pool creation with size ≥ `ALERT_WALLET_BUY_USD`.
4. **MAJOR_ANOMALY**: a watchlist token's 5m volume or price change versus its
   1h baseline ≥ `ALERT_ANOMALY_Z` σ or `ALERT_ANOMALY_PCT` %.

When in doubt, the signal goes to its specialty channel without a ping.

## Ingest architecture

```
WSS endpoint
  ├─ eth_subscribe newHeads → gap detector → chunked eth_getLogs backfill
  └─ eth_subscribe logs (topic allowlist: Transfer, Swap, Mint, Burn,
                          PairCreated/PoolCreated, pad-specific events)

Hot path (in-process)
  → ABI decode → feature compute (reserves, volume, velocity)
  → scorers → gate → Discord router

Cold path (async, never blocks alerts)
  → SQLite: cursor, paper metrics, precision tracking
```

Reconnect with backoff is mandatory. Every alert embed carries
`T+Xs = now − block_timestamp`.

## Metric definitions

- **Volume**: sum of swap amounts in USDC terms over the window, from the
  pool's USDC side. Pools without a USDC side are marked uncertain.
- **Market cap**: `price × totalSupply`, with explicit decimals.
- **LP depth**: the USDC reserve readable from pool or curve state.
- **Velocity**: `usd_in / minutes` since pool birth or window start.
- **Holders**: approximate unique addresses from Transfer logs (`holders≈`);
  a background job refines it.
- **Migration ratio**: `graduated / launched` per pad per window.

## Embed contract

Title = signal type. Fields: token (symbol + truncated address), venue/pad,
usd, velocity, lp, mcap if known, tx link, `T+Xs`. Colour: blue = info,
orange = watch, red = alert. Links point at the chain explorer.

## Acceptance criteria

1. The process starts, connects, and logs a heartbeat without posting to
   Discord.
2. A fixture LP surge posts to `#alerts` with `@everyone` exactly once; the
   duplicate is suppressed.
3. The major-coin digest posts on schedule with non-null fields or explicit
   `n/a`.
4. A WSS reconnect backfills missed blocks without double-posting.
5. The README explains how to add pad ABIs and watchlist tokens.

### Test harness

```bash
npm run test:unit          # math + decode
npm run test:fixtures      # recorded logs → snapshotted Discord payloads, no network
npm run test:alerts        # ping / no-ping matrix
npm run test:chain-probe   # eth_chainId + getCode watchlist report (live RPC)
npm run test:webhooks:dry  # optional; really POSTs only with ALLOW_LIVE_WEBHOOKS=1
```

| Case | Channel | `@everyone` |
|---|---|---|
| LP surge ≥ threshold | alerts | yes |
| LP surge below threshold | launchpads or major-coins | no |
| New pad token | launchpads | no |
| Migrate + hot volume | alerts | yes |
| Watchlist wallet fast buy | alerts | yes |
| Missing getCode on boot | alerts, once | no |
| Duplicate surge | — | suppressed |

Math golden vectors: 6-dec mirror vs 18-dec native conversions,
`mcap = price × supply`, `velocity = usd_in / minutes`,
`migrate_ratio = graduated / launched`.

Chain-probe gate: exits non-zero if every critical watchlist token is missing
on the connected chain, unless `ALLOW_EMPTY_CHAIN=1`.

Precision harness (paper only): every `#alerts` fire is followed up with
price/LP at T+5m/+15m/+1h in SQLite for a hit-rate report.
