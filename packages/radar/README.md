# radar

A 24/7 on-chain liquidity radar for **Arc (Circle L1)**. It watches pools, launchpads, labeled wallets and watchlist tokens and posts Discord embeds to four channels: `#smart-flow`, `#major-coins`, `#launchpads` and `#alerts`. Only four hard rules can ping `@everyone`.

> **Current state: testnet plumbing.** The default network is **Arc Testnet (5042002)**. The ecosystem tokens and pad tokens in `config/watchlists/` are **mainnet (5042)** contracts: 16/18 have no code on testnet; on mainnet all 31 configured CAs (tokens, launchers, factories, routers) have code (probe via rpc.arc-scan.org, 2026-09-14). On testnet the bot runs end to end, but its output is **not market data**. Every testnet embed says so. Flip to mainnet (below) for real signals.

Observe → score → alert. No trading.

---

## Repo layout

| Path | Role | Rule |
|---|---|---|
| `config/watchlists/` | Runtime watchlists (`major-coins`, `pad-tokens`, `launchpads`, `wallets`, `infra`; plus `launchpads.discovered` = curated evidence, not read; `launchpads.scraped` = raw tool output) | **The only watchlist dir the bot reads** (`WATCHLIST_DIR`, default `config/watchlists`). Hot-reloaded. |
| `docs/` | Design notes ([docs/design.md](docs/design.md)) | Documentation only. **Never imported or read by code.** |
| `.env` | RPC URLs + Discord webhooks | **The only place secrets live.** Gitignored. `.env.example` has placeholders. |
| `fixtures/` | Test-only chain, scenarios, snapshots, fixture watchlists | Never used at runtime. |
| `data/` | SQLite, probe reports, markers | Runtime output, gitignored. |

All three rules are enforced by `test/unit/repo-layout.test.ts`, which runs in the harness.

## Quick start

```bash
npm ci                      # once, at the repository root (npm workspaces)
cd packages/radar
cp .env.example .env        # fill RPC + webhooks
npm run harness             # Definition-of-Done gate (all must PASS; the chain probe needs a live RPC)
npm start                   # DISCORD_DRY_RUN=1 by default: payloads are logged, not posted
```

Go live: set `DISCORD_DRY_RUN=0` in `.env`. Optionally send one test embed per channel first:

```bash
npm run test:webhooks       # ALLOW_LIVE_WEBHOOKS=1, once (marker file in data/)
```

## Testnet ⇄ mainnet switch

One variable: `ARC_NETWORK=testnet|mainnet`. The code paths are identical.

| | testnet | mainnet |
|---|---|---|
| chain id | 5042002 | 5042 |
| RPC env | `ARC_TESTNET_HTTP_URL` / `ARC_TESTNET_WSS_URL` | `ARC_MAINNET_HTTP_URL` / `ARC_MAINNET_WSS_URL` |
| explorer links | testnet.arcscan.app | arcexplorer.org |
| embed footer | `arc-testnet \| radar v1` (+ "testnet plumbing" field) | `arc-mainnet \| radar v1` |

`ARC_HTTP_URL` / `ARC_WSS_URL` override the per-network URLs if set. `ARC_CHAIN_ID` is optional; if set, it must match the network.

**HTTP vs WSS on mainnet.**
- The public RPC `ARC_MAINNET_HTTP_URL=https://rpc.arc-scan.org` (chain 5042, no key) works for the **HTTP tools** `test:chain-probe`, `discover:onchain` and `discover:factories`. For `discover:onchain` you can raise `RPC_GETLOGS_MAX_RANGE`: 5,000 worked, 50,000 returned 503.
- The **live bot on mainnet refuses to start without `ARC_MAINNET_WSS_URL`** (exit 2). 24/7 ingest needs `newHeads`/`logs` subscriptions, so attach a QuickNode Arc Mainnet WSS endpoint.
- Testnet keeps its HTTP polling fallback.

**Safety rails**
- `ARC_NETWORK=mainnet` with no mainnet URL exits immediately with *"attach QuickNode Arc Mainnet endpoint"*.
- At boot, `eth_chainId` from the RPC must equal the network's chain ID, or the process exits (code 2). Mainnet config can never run against the testnet QuickNode, or the reverse.
- The boot probe runs `getCode` on every watchlist CA. Missing CAs are excluded from all loops and reported **once** in `#alerts`, with no ping. The report is persisted per chain in SQLite, so restarts don't repost. No prices are invented for missing contracts.
- `npm run test:chain-probe` exits 3 if **all critical majors** are missing, unless `ALLOW_EMPTY_CHAIN=1`. On testnet the harness sets that flag explicitly and prints that it did.

**Flip to mainnet**
1. Add `ARC_MAINNET_WSS_URL` (required) and ideally a matching `ARC_MAINNET_HTTP_URL` from the same QuickNode Arc Mainnet endpoint; the public HTTP RPC is only for probe/discovery. See [RPC limits](#rpc-limits).
2. `ARC_NETWORK=mainnet npm run test:chain-probe`: expect the critical majors `OK` (last run: 31/31 CAs with code). Remove `ALLOW_EMPTY_CHAIN=1` from `.env` for mainnet so a wrong RPC fails loudly.
3. Recalibrate thresholds for mainnet (e.g. `ALERT_LP_USD=50000`).
4. Use a separate `DB_PATH` per network (or keep the default; all tables are keyed by chain id).
5. `ARC_NETWORK=mainnet npm run harness`, then `npm start`.

Per-network contract differences live in YAML (`networks:` overrides; see TollyPad in `config/watchlists/launchpads.yaml`).

## Run on mainnet NOW (HTTP polling, before QuickNode WSS)

Arc mainnet is already live on the public RPC `https://rpc.arc-scan.org` (HTTP only, no WebSocket). The `mainnet-poll` profile runs the full bot on it.

```bash
cd packages/radar
npm run probe:mainnet            # 31/31 CAs should be OK
npm run start:mainnet-poll       # Ctrl+C to stop
```

**Profiles.** An env profile is a non-secret preset in `config/profiles/<name>.env`, selected with `ARC_PROFILE`. Precedence is **shell > profile > `.env`**, so secrets (webhooks) stay in `.env` and profiles never set `DISCORD_DRY_RUN` / `ALERTS_PING_ENABLED`.

| Script | Profile | Transport |
|---|---|---|
| `npm start` | none (`.env` only) | whatever `.env` says (currently testnet) |
| `npm run start:mainnet-poll` | `mainnet-poll` | mainnet, HTTP polling via rpc.arc-scan.org (`ALLOW_MAINNET_HTTP_POLLING=1`) |
| `npm run start:mainnet` | `mainnet` | mainnet, WSS: needs `ARC_MAINNET_HTTP_URL` + `ARC_MAINNET_WSS_URL` in `.env` (QuickNode) |
| `npm run probe:mainnet` | `mainnet-poll` | chain probe only |

**Boot sequence (mainnet-poll).**
1. Load `.env`, then the profile.
2. Assert the RPC's `eth_chainId` is 5042.
3. Confirm USDC mirror decimals.
4. Boot probe: `getCode` on all watchlist CAs.
5. Mark "live from now". Anything older only updates state and never posts.
6. **Warm start**: replay the last `WARM_START_HOURS` (default 6h ≈ 43k blocks). This took ~6 min on 2026-09-14 and seeds pools and their trust, pad launch stats, Warp curves, and major baselines.
7. Poll every `POLL_INTERVAL_MS` (1s). Each poll fetches `[lastHead+1, head]`. Events produced *during* the warm start are posted once caught up, with their real `T+Xs` delay.

Measured freshness: ~1.4–2.1s behind the chain (the WSS target is <1s).

**Fallbacks.**
- **Transport:** with a WSS URL the bot uses WebSocket (reconnect 1→30s backoff, stall watchdog `HEAD_STALL_SEC`, re-fetch `[lastHead, head]` over HTTP after reconnect). Without one it uses HTTP polling (testnet always; mainnet only with `ALLOW_MAINNET_HTTP_POLLING=1`).
- **Poll errors:** the poll is retried with exponential backoff up to 30s. Blocks produced during the outage are fetched on recovery, up to `BACKFILL_MAX_BLOCKS` (profile 20,000 ≈ 2.8h). Beyond that it logs `GAP_TOO_LARGE` and fetches only the tail.
- **`getLogs` errors:** transient errors are retried (4×, backoff). Then the range is **halved recursively** down to one block. A block that still fails is logged as `backfill failed` (visible, never silent).
- **Restart:** warm start rebuilds memory. With `WARM_START_HOURS=0` the bot resumes from the block cursor persisted in SQLite (`DB_PATH`, profile `data/radar-mainnet.sqlite`).
- **Discord:** a per-channel queue, `429 retry_after`, and 5xx retries; otherwise the error is logged.
- **Not automatic:** no failover between RPC providers. One RPC per run; switching = change profile/URL and restart.

**Recommended first runs.**
1. Dry run: `.env` `DISCORD_DRY_RUN=1` (payloads only in logs).
2. Posts without pings: `DISCORD_DRY_RUN=0` + `ALERTS_PING_ENABLED=0`. **The ping default is ON if unset.**
3. Pings: remove `ALERTS_PING_ENABLED=0` once the thresholds (in the profile) look right.

**When QuickNode mainnet arrives:** put its HTTPS + WSS URLs in `.env` (`ARC_MAINNET_HTTP_URL`, `ARC_MAINNET_WSS_URL`) and run `npm run start:mainnet`. Nothing else changes.

## Harness / Definition of Done

| Command | What it proves |
|---|---|
| `npm run test:unit` | Math golden vectors (6-dec mirror vs 18-dec native, sqrtPriceX96 → price, mcap, velocity, migrate_ratio). Decode of every fixture log. V3 topics match TollyPad's testnet bytecode. Network switch, watchlists, probe gate. |
| `npm run test:fixtures` | Replays 14 ABI-encoded scenarios (`fixtures/events/`) through the full pipeline with a fake chain and clock, and snapshots the exact Discord payloads (`fixtures/expected/`). No network. |
| `npm run test:alerts` | The ping/no-ping matrix, dedupe, reconnect gap backfill (≤5-block chunks, no double posts), spoofed pools, digest/leaderboard acceptance, embed contract. Static check: `@everyone` / `ping_everyone: true` exist only in the gate and payload builder. |
| `npm run test:chain-probe` | Live `eth_chainId` and a table of `address, symbol, kind, priority, code_bytes, chain_id, status` → `data/chain-probe-<network>.json`. |
| `npm run test:webhooks:dry` | One sample embed per channel, printed. POSTs only with `ALLOW_LIVE_WEBHOOKS=1`. |
| `npm run harness` | typecheck + all of the above, with a PASS/FAIL summary. |

After changing scenarios: `npm run fixtures:gen && npx vitest run test/fixtures -u`, then review the diff in `fixtures/expected/`.

## Architecture

```
WSS endpoint ─ eth_subscribe newHeads ─► HeadTracker ─ gap? ─► chunked eth_getLogs backfill ─┐
            └ eth_subscribe logs (DEX/pad topics; Transfer for watch tokens) ─────────────────┤
                                                                                               ▼
                         Pipeline (single in-process queue, txHash:logIndex dedupe)
                            decode → features (pools, vol buckets, LP windows, pads, majors, holders, wallets)
                                   → rules (LP_SURGE, PAD_MIGRATE_HOT, WATCHLIST_WALLET_FAST, MAJOR_ANOMALY, …)
                                   → Router (60s severity-aware dedupe) → gate (only ping authority) → embeds → webhook queue
                            cold path (async): SQLite events, alert_fires, precision samples, signal_fires/samples, pool_meta, cursor, reported_missing
```

- Hot path is in-process; no DB on the alert path. `T+Xs` on every embed = now − block timestamp.
- WS reconnect uses exponential backoff with jitter, a stall watchdog (`HEAD_STALL_SEC`) and auto-resubscribe. After a reconnect, `[lastHead, chainHead]` is always re-fetched. The block cursor is persisted, so a restart backfills the gap (bounded by `BACKFILL_MAX_BLOCKS`; beyond that it logs `GAP_TOO_LARGE` and keeps only the tail).
- No WSS URL → HTTP head polling fallback.
- The heartbeat (every 60s, **logs only**) reports head, lag_ms, pool count and decoded-event counters.

### Code map
`src/config` env/network/watchlists · `src/rpc` reader (rate-limited, cached), probe · `src/ingest` ws, heads, backfill, dedupe · `src/decode` ABI → normalized events · `src/math` units/prices · `src/features` state · `src/score` rules + **gate** · `src/discord` embeds, router, client · `src/jobs` boot probe, digests, precision, scorecard, calibrate · `src/score/paper.ts` paper fill/cost math + promotion rule · `src/store` SQLite · `src/tools` harness + ops CLIs · `src/testing` fake chain + scenario runner.

## Channels and ping rules

| Signal | Channel | Ping |
|---|---|---|
| `LP_SURGE`: net USDC added to one pool ≥ `ALERT_LP_USD` within `ALERT_LP_WINDOW_SEC` | #alerts | yes |
| `PAD_MIGRATE_HOT`: graduation, then post-migrate vol ≥ `ALERT_MIGRATE_VOL_USD` within `ALERT_MIGRATE_WINDOW_SEC` | #alerts | yes |
| `WATCHLIST_WALLET_FAST`: labeled wallet (recipient / sender / tx.from) buys ≥ `ALERT_WALLET_BUY_USD` within `ALERT_WALLET_AGE_SEC` of pool birth | #alerts | yes |
| `MAJOR_ANOMALY`: major 5m vol z ≥ `ALERT_ANOMALY_Z` vs 1h baseline, or \|price Δ\| ≥ `ALERT_ANOMALY_PCT`% vs 60m ago (min samples / min vol / cooldown) | #alerts | yes |
| `MISSING_ON_CHAIN` (boot), `BRIDGE_FLOW` / `BRIDGE_INFLOW` / `BRIDGE_OUTFLOW` ≥ `ALERT_BRIDGE_USD` | #alerts | **never** |
| `LP_WATCH` / `LP_REMOVE` (≥ `ALERT_LP_WATCH_USD`) | #launchpads (pad pools) / #major-coins (major tokens); other pools → logs | no |
| `NEW_LAUNCH`, `PAD_GRADUATED`, hourly `PAD_LEADERBOARD` | #launchpads | no |
| `MAJOR_DIGEST` every `MAJOR_DIGEST_SEC` (on-chain majors only) | #major-coins | no |
| `WALLET_ACTIVITY`, `EARLY_BUYER_DENSITY` (+ funder clusters), `BRIDGE_FLOW` / `BRIDGE_INFLOW` / `BRIDGE_OUTFLOW` ≥ `BRIDGE_FLOW_USD`, `BRIDGE_DEPLOY`, `BRIDGE_NET_FLOW` every `BRIDGE_DIGEST_SEC` | #smart-flow | no |

**The gate** (`src/score/gate.ts`) pings only when all of these hold:
- the signal is one of the 4 hard rules;
- its USD value comes from the **USDC mirror side** of the pool;
- the pool is **proven** to belong to an allowlisted factory, either by a PoolCreated/PairCreated event from that factory or by a `pool.factory()` → `factory.getPool/getPair()` round trip;
- `ALERTS_PING_ENABLED=1`.

Anything else is downgraded to its specialty channel or to logs. Spoofed pools emitting giant Mint events therefore can't ping (scenarios `12-spoofed-pool`, `16-mainnet-spoofed-major-pool`).

**Mainnet:** the canonical Uniswap V3 factory `0xf0db…3918` is allowlisted as `UniswapV3-Arc`. All 9 majors have USDC pools on it (`getPool` verified), and Lift, Tolly and RadarDEX launch into it, so majors can ping on mainnet (scenario `15-mainnet-major-anomaly`). A major whose only pools sit on a non-allowlisted factory still goes to #major-coins with no ping.

Dedupe: the same subject within `DEDUPE_SEC` (60s) posts once, unless severity escalates (LP_WATCH → LP_SURGE). LP_SURGE only counts deposits made after its last fire.

## Metrics: why "n/a", and what's real

**Alert embeds (compact).** Each signal type has a field policy (`FIELD_POLICY` in `src/discord/embeds.ts`). A field appears only if that event *can* know it **and** it was actually computed; unknown values are **omitted**, not printed as `n/a`. `T+Xs` is always shown.

| Metric | Undefined (omitted) when |
|---|---|
| `mcap` | no USD price yet (no USDC-side swap/reserves/slot0), non-USDC pair, `totalSupply()` unreadable, or decimals unknown |
| `lp` | pool has no USDC side (we never price token/token liquidity) or `balanceOf` failed; bonding curves have no LP |
| `velocity` | start time unknown (pool/curve born before the radar was watching and no window applies) |
| `usd` | not a USD-certain flow. A `confidence: usd uncertain` flag is shown only next to an actual USD number |

Launch embeds therefore show `token · venue/pad · tx · T+Xs`, plus `usd` (initial buy) / `lp` / `mcap` only when known. The helpers live in `src/features/signal-metrics.ts` and are unit-tested per undefined case.

**MAJOR_DIGEST (explicit n/a).** This is the one embed where every metric is a value or `n/a`, so gaps stay visible:

| Field | Source | `n/a` until |
|---|---|---|
| price | **source pool only** = the deepest trusted USDC pool holding ≥ `MAJOR_PRICE_MIN_LP_USD` ($1k): its last swap (<15 min), else its spot. Shown as `$x · last swap · $114.80k pool` | no trusted pool with ≥ $1k USDC. Dust pools never price a major (on mainnet COOL has two dust pools next to its $115k pool) |
| mcap | price × **fresh** `totalSupply()` | price or supply unknown |
| vol 1m/5m/1h, ΔLP 1h, buy/sell 1h | in-memory windows | radar coverage (boot, or warm-start history) spans the window. After that, `$0` / `no trades` are real zeros |
| lp (USDC) | USDC held by trusted pools (registry + allowlisted factory `getPool`/`getPair`), refreshed every `MAJOR_DEPTH_REFRESH_SEC` | any trusted pool's depth is unknown or stale. **Never a partial sum**: a throttled `balanceOf` must not turn $115k into $0.09 |
| holders≈ | holders with balance > 0, from **every Transfer since token creation** | holder backfill has synced |
| top10% (ex LP/burn/venues) | 10 largest balances ÷ totalSupply, excluding zero/dead, the token, its pools (plus any pool-like holder), and allowlisted factories/routers/aux/curves | holder backfill has synced |
| holders data | backfill status: `finding token creation block…` / `backfilling 43.2% (block …)` / `full history since block … · synced to …` / `capped` / `retrying after RPC error` | always shown |

**Holder backfill** (`src/jobs/holders-backfill.ts`, a background job on its own RPC reader and rate limit, started after the warm start):
1. **Birth block:** `created_block` in `major-coins.yaml` if set, else an archive binary search on `eth_getCode` (~25 calls).
   - rpc.arc-scan.org serves archive state unevenly (some backends answer 503 / `-32005` rate limit), so the background reader retries patiently (7 attempts, 1→32s).
   - A token whose search still fails is retried during the scan, and other tokens continue meanwhile.
2. **Scan order:** Transfer logs are scanned **from head back to birth** in shared `HOLDERS_BACKFILL_RANGE` chunks (arc-scan caps getLogs at 10,000 blocks).
   - One chunk covers every token still pending, so young tokens complete first and the total call count is ≈ (head − oldest birth) / range.
   - Failing ranges split, and throttling is retried.
3. **Integrity gate:** a token becomes authoritative only when **Σ balances == `totalSupply()`**. This is re-checked every pass.
   - A mismatch (history missed because a pruned backend answered, or a rebasing/non-standard token) keeps top10% `n/a`.
   - "holders data" then shows `⚠ Σbalances ≠ totalSupply (±x%)`. Fix it by setting `created_block`.
4. **Checkpoints:** balances plus the covered block interval are written to SQLite (`DB_PATH`) every `HOLDERS_CHECKPOINT_SEC` and on shutdown. **A restart resumes from the checkpoint**; it doesn't rescan history.
5. **Live sync:** live Transfer events and the periodic sync (`HOLDERS_SYNC_SEC`) interleave safely (deduped by log id / covered interval).
6. **Capping:** `HOLDERS_BACKFILL_MAX_BLOCKS` caps depth. A capped scan never becomes authoritative (`capped` in "holders data").
7. **RPC choice:** `HOLDERS_RPC_URL` can point the job at another archive RPC. The `mainnet` (QuickNode) profile uses rpc.arc-scan.org for this, because QuickNode Discover caps getLogs at 5 blocks.

**RPC resilience (all paths).** Transient failures (rate limits, 503 "could not complete", timeouts) are retried and **never cached as "absent"**. A pool whose metadata or factory check was throttled is re-resolved (≤ once/min) instead of staying untrusted forever.

**Observed on mainnet (2026-09-14, rpc.arc-scan.org):**
- BARC reached `holders≈ 505 · top10% 37.4%` and Arcash `holders≈ 555 · top10% 24.1%`, both with Σbalances == totalSupply.
- The older majors keep backfilling at ≈ 250k blocks/min, and every restart resumes from the checkpoint.
- `MAJOR_ANOMALY`'s price branch uses the same source-pool price series, so a dust-pool trade can't fake a price move.

### Edge scorecard (paper only)

Measures which signals would have made money **before** any threshold tuning or pings. Cold path only: it never changes a gate decision, posting, `DISCORD_DRY_RUN` or `ALERTS_PING_ENABLED`, and nothing on the alert path waits for its writes.

**What is recorded (live bot).**
- **`signal_fires`**: every *routed* signal with a scoring direction, in any channel (NEW_LAUNCH, LP_WATCH, LP_REMOVE, EARLY_BUYER_DENSITY, BRIDGE_FLOW, hard rules, …). Muted warm-start history and logs-only refusals are not recorded.
  - Meta signals are not scored: MAJOR_DIGEST, PAD_LEADERBOARD, MISSING_ON_CHAIN.
  - Each row stores type, channel, ping, token, pool, direction, usd, price at fire (with its source), pool fee, pool USDC depth, event/fired time and `detect_lag_ms`.
  - The write is deferred with `setImmediate`.
- **Direction** per type lives in one table, `SIGNAL_DIRECTION` (`src/score/paper.ts`): `LP_REMOVE` = **avoid** (scored as the price drop avoided); every other scored type = **long**.
- **`signal_samples`**: in-memory price and depth at T+1m/5m/15m/1h. No RPC, so sampling never competes with the alert path.
- **`pool_meta`**: dex, token0/1, fee, factory, trusted, USDC side and depth. Written whenever `PoolRegistry` resolves a pool.
- The legacy `alert_fires` / `precision_samples` tables and `report:precision` are unchanged.

**Paper fill model.** Returns use raw on-chain prices (decimals cancel):
- **Entry** = first swap (or curve trade) in the signal's pool at/after `fired + PAPER_LATENCY_MS` (default 3000).
- **Exit** = last print at/before `fired + horizon`.
- **Cost** = `2 × fee tier + PAPER_SIZE_USD / (2 × USDC depth)` (default $500), capped at 100%. UniV2 pairs assume a 0.30% fee.
- **Unknown depth or fee** → the fill is reported but has **no net return**. It is never treated as free.
- **Hit** = net > 0.
- **Horizons past the end of stored data** = `pending`.

```bash
npm run report:scorecard -- --days 7 [--db data/radar-mainnet.sqlite] [--horizons 60,300,900,3600] [--gate-horizon 900]
```
Prints per type, per pad/venue and per token: fires, filled, pending, net n, hit%, mean/median net, mean gross, average detect lag, and drawdown avoided (avoid signals).

It also prints a **promotion verdict**: a type is eligible for pings only when, over 7 days, net n ≥ 30, net hit ≥ 55% and mean net > 0. **This is reported only, never wired to the gate.** `--days` is anchored at the newest stored event, so DB copies work.

**Threshold calibration (offline replay).**
```bash
npx cross-env ARC_PROFILE=mainnet-poll npm run calibrate -- --rule MAJOR_ANOMALY --grid z=3,4,5 --grid pct=20,50,100 --db <copy.sqlite>
npm run calibrate -- --rule LP_SURGE --grid lp=10000,25000,50000 --grid window=60,120
npm run calibrate -- --rule NEW_LAUNCH
```
- **What it replays:** the stored `events` table through the real rule code: `MajorState.evaluate`, `evaluateLp` with router dedupe, and the launcher-authorization check for NEW_LAUNCH. Each fire is paper-scored at 5m/15m, net of costs, for every grid point. Grid defaults come from env/profile.
- **Pool metadata:** comes from stored PoolCreated logs, then over the rate-limited public RPC (chainId-asserted, `--rps`, `--no-rpc`). It is cached in `pool_meta`, so re-runs are fast.
- **Approximations:**
  - Fire time = block time (`PAPER_LATENCY_MS` stands in for detection plus execution).
  - Depth = USDC depth when calibrate ran.
  - A major's price source = its deepest trusted pool now.
  - Both tools are only as good as ingest coverage.
- **Point `--db` at a COPY while the bot runs.** The tools add a read index and fill `pool_meta`.

**Still approximate:** `holders≈` is derived purely from `Transfer` logs. Tokens that change balances without emitting Transfer (rebasing, reflection/fee-on-transfer quirks, non-standard mints) drift. The digest flags negative balances as `⚠ non-standard token?`. Explorer indexers (with traces and token-specific handling) can differ slightly.

## Adding data

**Major CAs** go in `config/watchlists/major-coins.yaml`:
```yaml
tokens:
  - { symbol: COOL, address: "0x…", priority: critical }   # critical majors drive the probe gate
```
**Wallets** go in `config/watchlists/wallets.yaml`: `- { address: "0x…", label: smart-1, tags: [smart] }`.
**DEX factories** (needed for trusted pools and major pings) go in `launchpads.yaml` under `dex:` as `{ name, factory, kind: univ2|univ3 }`.
**Bridges** (Ellipse) go in `infra.yaml` under `bridge[].contracts: ["0x…"]`. USDC mirror transfers to or from them are scored as `BRIDGE_FLOW`.

**CCTP** (the active bridge signal on mainnet) goes in `infra.yaml` under `cctp: { message_transmitter, token_messenger, local_minter, source_domain, source_domain_label }`. `message_transmitter`'s `MessageReceived` + the paired USDC mint (a `Transfer(0x0 -> recipient)` on the chain's `usdcSystemEmitter`, **not** the USDC mirror address — see `config/networks.ts`) fire `BRIDGE_INFLOW`; `token_messenger`'s `DepositForBurn` fires `BRIDGE_OUTFLOW`. `source_domain`/`source_domain_label` are the fallback shown when `MessageReceived`'s own `sourceDomain` field isn't decoded (its event ABI is reconstructed from Circle's public interface, not independently verified against Arc bytecode — see `src/abi/cctp.ts`; a decode miss only costs that enrichment, never the signal). A CCTP arrival ≥ `BRIDGE_FOLLOW_MIN_USD` starts following that wallet for `BRIDGE_FOLLOW_MINUTES`: its next buy (AMM swap or bonding-curve trade) fires `BRIDGE_DEPLOY` with the token, pool, size, time since arrival, and whatever the radar already tracks for that token (pool depth, holders≈/top10% if tracked since birth, buy/sell 1h, pool age). `BRIDGE_NET_FLOW` posts a rolling 5m/1h inflow/outflow/net digest every `BRIDGE_DIGEST_SEC`, skipped when both windows are flat.

Watchlists **hot-reload**: saving a YAML re-runs the boot probe and resubscribes. Invalid YAML is rejected, and the previous lists are kept.

Addresses are matched lowercase. Use `networks: { testnet: {…}, mainnet: {…} }` on a pad or dex to override `factories/routers/aux` (or the legacy `factory/router/bonding/kind`) per chain.

`factories[]` entries are `{ address, kind, role?, label? }`:

| kind | meaning |
|---|---|
| `univ2` / `univ3` | AMM factory = pool trust root. Default role is `amm`; use `launch` if its pools are launches, `migration` if they are post-graduation pools. |
| `lift` / `tolly` / `warp` / `radar` | Mainnet launcher adapter. Only this exact emitter may produce launches for that adapter. |
| `generic` | Placeholder `TokenCreated`/`Graduated` ABI. |
| `todo` | Code is verified but there's no decoder yet. Probed only, never trusted or decoded. |

`aux` lists verified helper contracts (lockers, vaults, implementations), which are probed only.

`config/watchlists/launchpads.discovered.yaml` is the curated evidence file, and runtime never reads it. Every mainnet CA in `launchpads.yaml` must appear in it; a unit test enforces this. `discover:factories` writes raw output to `launchpads.scraped.yaml` and never overwrites the curated file.

### Mainnet venue status (2026-09-14)

| Venue | Mainnet wiring | Decoded events |
|---|---|---|
| **Lift** | factory `0x3f29…9153` (`lift`), aux fee_locker, lp_vault | Unnamed launch event `0x71582b1e…` (layout verified from 276 logs): token, creator, pool (UniV3-Arc), quote, initial buy. Trades are pool V3 swaps. |
| **Tolly** | TollyPad `0xcad7…8c9b` (`tolly`), router | `TokenCreated(token, creator, name, symbol, pool, …)`. Trades are pool V3 swaps; `DevBuy` is already a swap, so it isn't counted twice. Testnet keeps the UniV3-factory path. |
| **Warp** | launch proxy `0x0dCa…1255` (`warp`), WarpDex factory `0x3233…577a` (`univ2`, migration), router | `TokenCreated(token, curve, creator, …)` and curve `Trade(trader, isBuy, quote, tokens, …)`. The quote is **native USDC, 18 decimals** (checked against `tx.value`). Curves created before boot are verified via `factory()` but stay untrusted, so they never ping. |
| **RadarDEX** | token launcher `0x4B63…C93a` (`radar`), curve launcher `0x62d6…073A` (`todo`), router | `TokenLaunched(token, creator, pool, …)`; `InitialBuy` is already a swap. |
| **UniswapV3-Arc** | factory `0xf0db…3918` (`univ3`, amm) | Standard V3. Trust root for majors and launch pools. |
| **Dyor** | routers `0x33c2…BFa3`, `0xcc9C…91ce` | **TODO**: no factory yet. |
| **Sharc, Argus, Long** | none | **TODO**: no factory CA found yet. |
| **Ellipse** (app-level bridge) | none | **TODO**: no labeled contract CAs, so its generic `BRIDGE_FLOW` stays inactive. |
| **CCTP** (Base↔Arc) | MessageTransmitter `0x81D4…4B64`, TokenMessengerV2 `0x28b5…cf5d`, localMinter `0xfd78…5D002` — verified on chain 2026-09-15 (Arc `localDomain()==26`, both sides' `remoteTokenMessengers` wired) | `MessageReceived` + paired USDC mint → `BRIDGE_INFLOW`; `DepositForBurn` → `BRIDGE_OUTFLOW`; wallet-follow → `BRIDGE_DEPLOY`. |

### Adding a pad (ABI)
1. Get the pad's factory/bonding CA. `npm run discover:factories` scrapes the pad site + JS bundles and classifies bytecode; `npm run discover:onchain -- --blocks 600` lists creation-event emitters.
2. If it is a Uniswap V2/V3 fork (its bytecode embeds `PairCreated`/`PoolCreated`), set `kind: univ2|univ3` and you're done.
3. Otherwise write an adapter:
   - Record real logs for the contract (bounded `eth_getLogs`), resolve topic hashes in a signature DB, and confirm the field meanings and decimals against real transactions (`tx.value`, receipts). Unnamed events are decoded positionally, using verified fields only.
   - Add the ABI to `src/abi/pads-mainnet.ts` and a case in `src/decode/adapters.ts` that maps it to `pad_token_created` / `pad_trade`.
   - Add the adapter name to `VENUE_KINDS`, then `factories: [{ address, kind: <adapter> }]` under `networks.mainnet`.
4. Add a synthetic scenario in `src/tools/gen-fixtures.ts` and, ideally, a recorded receipt in `fixtures/mainnet-real/receipts.json`, then regenerate and snapshot.

## Ops

- **pm2**: `pm2 start ecosystem.config.cjs`. **Docker** (from the repository root): `docker build -f packages/radar/Dockerfile -t ak-arc-radar . && docker run --env-file packages/radar/.env -v $PWD/packages/radar/data:/app/packages/radar/data ak-arc-radar`.
- **Kill switches**:
  - `DISCORD_DRY_RUN=1` stops all posting.
  - `ALERTS_PING_ENABLED=0` stops every `@everyone`; alerts still post.
  - Removing a webhook URL drops that channel.
- **Chaos test**: `CHAOS_WS_DROP_SEC=20 npm start` drops the socket once so you can watch the reconnect and backfill logs.
- **Precision (paper)**: every hard-rule `#alerts` fire is stored and price/LP is sampled at T+5m/15m/1h. Run `npm run report:precision -- --days 7`.
- **Edge scorecard (paper)**: every routed signal is scored against paper fills net of fees/impact: `npm run report:scorecard -- --days 7`. Offline threshold replay: `npm run calibrate -- --rule MAJOR_ANOMALY --grid z=3,4,5`. See [Edge scorecard](#edge-scorecard-paper-only).
- **Logs**: pino JSON (`LOG_LEVEL`). Pipe to `pino-pretty` locally.

### RPC limits
QuickNode's Discover plan caps `eth_getLogs` at **5 blocks** (`RPC_GETLOGS_MAX_RANGE=5`; Arc blocks are ~0.5s). A 20-minute gap is ~480 chunks × 2 filters at `RPC_MAX_RPS`. Raise both on a paid plan.

## Known gaps / TODO
- **Pads still TODO on mainnet**: Sharc, Argus and Long have no factory CA; Dyor has routers but no factory. RadarDEX's curve launcher `0x62d6…073A` has no decoder, since it produced no logs in 600k blocks.
- **Graduations**: Warp's live implementation replaced `Migrated`/`Graduated` with unnamed events, and WarpDex's 5-arg `PairCreated` has no logs yet. So `PAD_MIGRATE_HOT` currently only fires for `generic` pads. Lift, Tolly and RadarDEX have no bonding curve (the pool exists at launch).
- **Ellipse bridge** contract CAs are unknown, so its generic `BRIDGE_FLOW` is inactive until they're added. CCTP (Base↔Arc) is active — see the venue table above.
- CCTP's `MessageReceived` sourceDomain is best-effort (event ABI not independently verified on Arc); a decode miss falls back to `infra.yaml`'s `cctp.source_domain`, which is correct as long as only one corridor is wired.
- `holders≈` counts Transfer participants (24h); `top10%` is `n/a` unless tracked since token birth. Funder clusters only see USDC transfers the radar subscribes to.
- Token/token pools (no USDC side) are not USD-scored in v1.
