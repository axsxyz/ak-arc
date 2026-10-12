# executor

Bridge USDC Base → Arc via CCTP, buy one target token in its deepest
trusted pool, and sell fractions of the position on hotkeys. Holds the
repo's only private key. Design invariants: [docs/invariants.md](docs/invariants.md).

`src/bridge.ts` was the first stage to work end to end and is the style
reference for every convention here: preflight shape, abort style, timing
logs, fee quoting. The other stages follow it.

---

## Ground truth (verified on chain 2026-09-15)

**Arc mainnet is live.** chain 5042, `https://rpc.arc-scan.org`.

**Decimals.** Fee units and native value are **18-decimal** (250k gas at
20 Gwei = 0.005 USDC, confirmed empirically). The USDC ERC-20 interface
at `0x3600000000000000000000000000000000000000` is **6-decimal**. Mixing
them is a 1e12 error and the most expensive bug available in this module.
Read balances through the ERC-20 interface, never the native balance.

**CCTP is wired both ways.**

| What | Value |
|---|---|
| TokenMessengerV2 (uniform CREATE2, both chains) | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| Arc localMinter | `0xfd78EE919681417d192449715b2594ab58f5D002` |
| Arc MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Base USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Iris | `https://iris-api.circle.com` |
| Domains | Base 6, Arc 26 |

Resolve the MessageTransmitter at runtime via `localMessageTransmitter()`
anyway. Never hardcode a CCTP address that can be read.

**Open question (2026-09-15, since partly answered).** A domain-26
mainnet burn sat at `pending_confirmations` well past the Fast Transfer
target (`timing.fastTransferTargetMs`): Circle may not yet have been
signing attestations for this domain, and its docs still listed domain 26
as "Arc testnet" with no Arc mainnet domain published. A completed
Base→Arc mint was recorded on 2026-09-16
(`packages/radar/fixtures/mainnet-real/receipts.json`, `cctp_mint`).
Domain 26 on mainnet is verified-by-observation, not documented.
`mint-watch` polls a pending burn and flips to `complete` the instant
Circle signs it; that is the detector.

**Latency (observed in a live run, 2026-09-15).** Burn on Base ~674 ms.
Attestation is the only slow stage and the only one outside our control.
Fast Transfer allowance was not exhausted (~54M USDC). Iris quoted 6→26
at 0.325 bps (threshold 1000).

**Example target.** `config/executor.json` ships with a placeholder
target (`0x1111…1111`) and pool (`0x2222…2222`); replace both with a
verified token and pool before any live run. The router `0x53bf…6f77` is
SwapRouter02-shaped (`exactInputSingle` 0x04e45aaf wrapped in
`multicall(deadline, bytes[])`), and its `factory()` (observed on chain,
2026-09-15) is `0xf0db…3918`, the canonical UniV3 factory on Arc. A typical token has one deep tier (e.g.
1%, ~$115k USDC in the case the guards were tuned on) beside dust tiers
holding < $0.001; the dominance guard exists for exactly that layout.

---

## Stages and commands

Every stage is independently re-runnable. Dry run is the default
everywhere; `--live` on a stage that spends or bridges USDC (bridge,
bridge-out, buy, run) needs an explicit size (`--amount`, or
`--bridge-amount`/`--buy-amount`, or `--burn-tx` to resume); `sell.ts`
sizes each tier as a percentage of the held balance. **One
invocation style: `npx tsx`.** npm rewrites option-shaped arguments into
its own config even after `--`, so there are no npm scripts for the
stages (only `typecheck`, `test:unit` and `test`); a run started through npm
aborts with "Run with npx tsx src/<stage>.ts — npm scripts are not
supported." Every hint the tools print is a ready-to-paste `npx tsx`
command with real values.

`run.ts` takes bridge size and buy size separately: `--bridge-amount` is
what gets burned on Base, `--buy-amount` is what gets spent on the swap.
`--amount` is shorthand for setting both to the same value; combining
`--amount` with either of the others is rejected. `--buy-amount` is a
ceiling, never a clamp: it must be <= what actually lands on Arc after
the mint (read from the post-mint balance — the CCTP protocol fee is
deducted from the transfer), or the run aborts before the buy is
signed (the burn and mint have already happened; the USDC stays on Arc).
Omit `--buy-amount` to buy the full minted amount. With `--prefunded`,
`--bridge-amount` is ignored; only `--buy-amount` (or `--amount`) applies.

| Command | What |
|---|---|
| `npx tsx src/run.ts --amount 5000` | dry-run every stage: config, readiness, fee quote, tier table, impact, payloads |
| `npx tsx src/run.ts --live --amount 5000` | burns 5000 and mints, then the buy of 5000 aborts whenever a protocol fee was deducted (see Known issue under Status and limitations) [TODO: fix] |
| `npx tsx src/run.ts --live --bridge-amount 25000 --buy-amount 10000` | burn 25000, buy only 10000 of what lands |
| `npx tsx src/run.ts --live --burn-tx 0x…` | resume: mint the existing burn, then buy the minted amount |
| `npx tsx src/run.ts --live --prefunded --buy-amount 5000` | USDC already on Arc: skip bridge + mint |
| `npx tsx src/mint-watch.ts --burn-tx 0x…` | poll one burn's attestation (dry: one poll); add `--live` to mint when complete |
| `npx tsx src/bridge.ts --live --amount 1` | burn + mint only |
| `npx tsx src/bridge-out.ts --live --amount 1 [--to 0x…]` | return leg: burn on Arc, mint on Base (`--to` overrides mintRecipient, default this wallet) |
| `npx tsx src/buy.ts --live --amount 5000 [--slippage-bps 250]` | buy only; prints the exact sell command on fill |
| `npx tsx src/sell.ts --live --cost-usdc 5000 --entry-tokens N` | multi-position hotkey sell TUI, every held token armed at once (`--cost-usdc`/`--entry-tokens` fix PnL entry for trade.targetToken's position) |
| `npm run typecheck` / `npm run test:unit` | DoD |

`run` resolves the pool the same way `buy`/`sell` do — cached pool >
configured tier > full discovery — **before** the mint, so a token with
a verified `pool` in config fast-arms instead of enumerating the full
tier table (observed in live runs: ~30 s on the public RPC). Only a two-read refresh of the
chosen pool sits on the post-mint critical path either way.

**Nonce.** One Arc counter, read once (`pending`) at the moment the
first Arc tx is about to go out: at mint time for mint-watch, right
before the buy when prefunded. Then local increments: mint, approve,
swap. Never re-read between mint and buy. On a revert the nonce is
consumed: the sell TUI keeps counting, while buy, run and mint-watch
abort and report the consumed nonce. On "no receipt" (blocklist reverts
produce none) every stage aborts because the counter is unknown.
`mint-watch` reads its nonce and takes the single-instance lock only at
mint time, so it can wait for hours beside a sell TUI without going stale.

**Gas floor (permanent rule).** The preflight, and the buy again on a
fresh read right before spending, abort unless after the spend and this
run's own txs at least `gas.reserveTxCount` transactions of
`gas.reserveGasPerTx` gas remain, priced at the live gas price plus
priority (not the maxFee cap). Native USDC and the ERC-20 mirror are one
balance: spending through the ERC-20 drains the gas. A position you
cannot sell is worse than a position you did not take.

**Approvals are unlimited and one-time.** The buy checks the USDC
allowance to the router first and only approves (unlimited) when it does
not cover the spend, so a repeat buy carries no approve. With
`trade.approveOnFill` (default true) it also approves the bought token to
the router right after the fill, on the same nonce counter, and waits for
the allowance to be readable. The sell
TUI then arms with no approve, no broadcast retry and no allowance poll on
its path; if it ever finds the allowance short it says so in bold and pays
for the approve itself.

**Cached pool.** `trade.tokens[addr].pool` names a verified pool. When set,
buy and sell skip discovery entirely: they read that one address and
assert `factory()` is allowlisted and the factory's own `getPool` agrees,
`token0/token1` are the target and USDC, `fee()` equals `expectedFeeTier`
(required alongside `pool`), and depth is above the floor. Any mismatch
aborts loudly; a wrong cached pool never falls back to discovery. The
full table still audits in the background and prints an `AUDIT WARNING`
if a deeper trusted tier exists than the cached one. Without `pool`, the
paths below apply.

**Fast arm.** When the token has `expectedFeeTier`, buy and sell resolve
only that tier (getPool, trust round-trip, depth: about 10 reads) in
parallel with the preflight and arms, then fills the full tier table in
the background and prints it with the dominance verdict when it lands.
The sell gas limit is `gas.reserveGasPerTx`; no estimate call sits on the
exit path.

**PnL.** Entry is fixed at the fill: `--cost-usdc` over the tokens
received (`--entry-tokens`, printed by buy.ts; else the balance when the
TUI started). It never moves when you sell. The TUI shows realised
(USDC actually received across the session's sells), unrealised
(remaining balance × spot), the remaining cost basis, and total =
realised + unrealised − cost with its percentage over cost. A full exit
reads realised − cost (about −2% on a 1% tier from fees), never −100%.
Restarting the TUI mid-position without `--entry-tokens` would anchor the
entry to the remaining balance, so pass it.

**Sell TUI is multi-position: one process arms every held token.** Same wallet,
same nonce counter — two TUIs (or two single-position processes) would let a fire
in one silently invalidate the other's pre-signed tiers, so one process
managing every position is the only safe shape. Positions: `trade.targetToken` +
every `trade.tokens` key + `EXTRA_TOKENS` (`.env`, comma-separated), filtered
to non-zero balances — a position with a zero balance simply doesn't appear.
`--cost-usdc`/`--entry-tokens` track PnL for `trade.targetToken`'s position only;
every other position shows position/tiers with PnL `n/a`.

**Position selection.** A portfolio header is always visible above the tier
table: USDC cash, one line per position (balance, mark = balance × spot, ▲▼
since the previous refresh, % of pool depth, and "exit ≈" — modelled net
proceeds of selling the WHOLE position in one order, fee + impact included; mark
is what it looks like, exit is what you'd get), then TOTAL. TAB or `[` `]`
cycles the selected position; a letter (a/s/d/…, assigned in arming order and
printed in the header) jumps straight to one. **Number keys sell that % of
the SELECTED position, never any other** — the armed position is marked ▶ and bold,
unmistakably, because a mis-selected position firing 100% is the worst outcome
available here. Per-position `slippageBps`, hotkey tiers and pool overrides
resolve via `trade.tokens[addr]`, falling back to the global `sell.*`;
`--slippage-bps` still overrides every position for the session.

**Sell TUI layout.** Portfolio header first, then the selected position's
position and PnL (the TOTAL line is the only coloured thing: green or red
by sign), then its tier table with a one-symbol state per tier (● signed at
the current nonce, … stale or re-sign pending, ○ unsigned in dry run, ✕
refused), and the event log in dim between renders. Values that changed
since the last render are bold. The bps note and the symbol legend print
once at arm time. The screen is never cleared: scrollback is the audit
trail.

**Nonce and pre-signing, across the whole portfolio.** One nonce counter
for the whole process, single-flight as before — instrumented on stdout as
it happens: per keypress the timestamp, keypress→broadcast ms, the nonce
used, the tiers invalidated across every position, per-position re-sign start/end,
and every rejected press with its reason (in-flight broadcast, re-signing
in progress, same-key double-tap on the same position inside 500 ms, stale
signature). Every tier of every position is pre-signed at the same nonce; a fire
consumes it and invalidates all of them, everywhere: re-sign happens
without waiting for the receipt (so a second tier pressed right after, on
any position, lands behind the first) and recomputes the FIRED position's tiers on
its projected balance while every other position re-signs on its unchanged
balance — 3 positions × 5 tiers is ~15 signatures, and every press logs
its keypress→broadcast time [TODO: measured value]. The log names which positions were
re-signed, not just which tiers.

**Sell TUI.** Renders balance, pool depth, spot and unrealised PnL for
every position every `timing.statePollMs` over HTTP (WSS block subscription when
`ARC_MAINNET_WSS_URL` is set), discarded if a fire is in flight (the
generation guard). Every hotkey tier, every position, is built and signed ahead
of the keypress at the current nonce and re-signed on every refresh
(deadline, balance and spot move). A press only broadcasts. `q` quits.

---

## Guards — what aborts (exit 2) and what does not

Aborts, always, never a warning:

- chainId mismatch on either RPC; route not wired on Base or Arc; Arc
  transmitter unset; zero gas on Arc; Arc gas price above `gas.arcMaxFeePerGasGwei`
- pool not on an allowlisted factory (`factory.getPool` + the radar's
  `PoolRegistry` round-trip)
- deepest pool below the **per-token depth floor**:
  `trade.tokens[addr].minPoolDepthUsd`, else `trade.defaultMinPoolDepthUsd`.
  A token with no entry uses the default, so a fresh launch is tradeable
  without editing config first.
- **split liquidity** (full-discovery path only; with `pool` or
  `expectedFeeTier` set, the background audit reports it as
  `AUDIT WARNING`): the deepest tier must be ≥ `trade.dominanceRatio`
  (20) × the runner-up. This is the primary dust-pool guard; absolute size
  cannot tell a fresh pool from a dust pool, a ratio can. Two comparable
  pools mean choose explicitly via `trade.tokens[addr].expectedFeeTier`.
- any tier's depth unreadable after 3 passes (a failed read is not a zero)
- `--amount` above `trade.maxNotionalUsd` (fat-finger cap, not an impact cap)

Reported, never aborted:

- `expectedFeeTier` set and a deeper tier exists (liquidity moved): the
  background audit prints `AUDIT WARNING`; the configured tier is still used.

**Impact never blocks.** paper.ts's model (`2 × fee + size / (2 × depth)`)
is computed at the real size and reported as **round-trip cost** in
`trade.preflight`, `trade.fill` and `trade.sell` with realised vs
predicted. It prices both legs: on the 1% tier it reads 200 bps before any
size effect. The only on-chain guard is `minOut` from `slippageBps`
(`--slippage-bps` overrides the JSON; pick it at execution time).
`sell.perTierMaxImpactBps` is `null` (informational) unless you set it.

The full tier table (tier, pool, depth, liquidity, trust) is logged at
preflight and shipped in `trade.preflight` so the choice is auditable.

---

## Fast Transfer is mandatory and must be provably honored

This section is `bridge.ts`'s inbound leg (Base -> Arc) only. The return
leg, `bridge-out.ts` (Arc -> Base), does **not** force Fast Transfer — see
below for why.

Always burn at `minFinalityThreshold = 1000`.

**Never hardcode maxFee.** The protocol fee scales with the amount:

```
protocolFee = amount * round(minimumFee * 100) / 1e6
```

`minimumFee` is in bps (observed on 2026-09-15: 0.325 for 6→26). A
constant sized for a small amount is too small for a larger one
[TODO: observed amounts], and CCTP then **downgrades to Standard
Transfer silently** rather than reverting. `bridge.ts` quotes
`/v2/burn/USDC/fees/6/26` immediately before every burn and aborts if the
1000-threshold quote is absent.

`mint-watch` measures burn→attestation latency against
`timing.fastTransferTargetMs` and emits `bridge.downgrade_detected` on
breach. It also dumps the completed Iris message once and lists every key
containing "finality", so the served threshold is never invisible again.

Requesting and verifying Fast Transfer is in scope. Depending on Fast
Transfer finishing within `timing.fastTransferTargetMs` is not — size as
if attestation could take 20 minutes.

---

## bridge-out.ts — the return leg (Arc -> Base)

Mirrors `bridge.ts` with the direction reversed. Same fee-quote discipline
(never a hardcoded `maxFee`, always quoted live), same preflight discipline
(both chainIds asserted, the route re-read as wired, an explicit nonce,
`--dry-run` default, `--live` needs an explicit `--amount`) — but three
things differ, each for a concrete on-chain reason:

- **No forced `minFinalityThreshold`.** Arc's own (standard) attestation
  is fast [TODO: measured latency], so there is no separate "Fast Transfer" tier worth asking
  for the way the inbound leg does — standard is already fast. `quoteFeeOut`
  never sends threshold 1000 blindly: it reads whatever
  `/v2/burn/USDC/fees/26/6` actually quotes (the cheapest offered, if more
  than one) and burns at THAT threshold.
- **Two different chains need gas.** Approve + burn happen on Arc, so
  Arc's existing gas floor (`assertGasFloor`, inside `preflight`) covers
  them, same as every other Arc-signing stage. receiveMessage happens on
  Base and costs **ETH, not USDC** — a separate `assertBaseGas` checks the
  Base ETH balance and aborts if it can't plausibly cover the mint, the
  same "abort, don't guess" discipline applied to a chain `preflight`
  itself never looks at.
- **The signing pattern per chain follows who's being written to.** The
  burn (Arc) uses the same manual `NonceTracker` + `signTx` + `broadcast`
  discipline `mint-watch.ts` uses for Arc — one explicit counter, read once,
  incremented locally. The mint (`receiveMessage`, Base) uses the wallet
  client's own nonce handling, exactly like `bridge.ts`'s Base-side burn:
  single-shot per session, no need for the same manual discipline.

`TOKEN_MESSENGER` is the identical CREATE2 address on both chains (see
"Ground truth"), so the approve target and the `depositForBurn` target are
the same constant `bridge.ts` already uses — just called against Arc's
client instead of Base's. Base's `MessageTransmitter` is resolved the same
way Arc's is: `localMessageTransmitter()`, at runtime, never hardcoded.

---

## Traps already paid for

- **The single-instance lock is keyed per wallet.** `data/executor-<address>.lock`,
  not a single global `data/executor.lock` — a global lock blocked six unrelated
  bridges run with different keys. Different `PRIVATE_KEY`s never
  block each other; the SAME key still can't run two signers at once. Released
  on normal exit and on SIGINT — a stage without a TUI (bridge, bridge-out,
  buy, run, mint-watch) can sit for minutes waiting on an attestation, and
  Ctrl+C there is a real SIGINT the process must release the lock on, not
  just a byte in a raw-mode stdin stream (that's `sell.ts`'s own path, via
  its `q`/Ctrl+C keypress handling — SIGINT never fires there since raw mode
  suppresses it).
- **Base serves sub-second preconfirmation receipts.** A receipt does NOT
  mean the resulting state is readable. After any tx whose effect the
  next tx depends on, poll the actual state (`pollState`). Done for the
  Base allowance, the Arc USDC balance after the mint, and router
  allowances before swaps.
- **npm rewrites option-shaped arguments** into its own config, even after
  `--`. There are no npm scripts for the stages; every run is `npx tsx`,
  and an npm-launched run aborts with a one-line message.
- **MetaMask exports keys without `0x`.** Normalised, never rejected.
- **Public RPCs rate-limit bursts.** `rpc.arc-scan.org` answers "could not
  complete this request" on bursts. Every Arc read, receipt poll and
  broadcast goes through `src/rpc-pool.ts`: transient errors retry with
  backoff, and after `ARC_RPC_ROTATE_AFTER` consecutive failures the pool
  rotates to the next endpoint of `ARC_MAINNET_HTTP_URL`, per call, no
  restart. A node rejection (nonce too low, underpriced, revert) never
  counts and never rotates. `broadcast()` keeps its invariant on top: the
  same signed bytes are re-sent and the hash is checked first, whichever
  endpoint is active. Every endpoint's chainId is asserted at first use
  and a wrong-chain one is dropped for the session; so is one that answers
  with a persistent quota/auth refusal (401/402/403, or 429 with a quota
  body), logged as `RPC DROPPED host: quota/auth …`. Rotations are logged
  (`RPC rotate: a -> b (why; N consecutive failures)`) and the sell TUI
  header shows the active endpoint with `*`/`(rotated)` once it moved.
  **A failed read is never interpreted as state.** Every error is
  classified before anything reacts to it: transport/timeout/5xx/burst
  throttle (retry, count toward rotation), quota/auth (drop the endpoint),
  an on-chain answer such as a revert or "returned no data" (that IS data),
  or a node rejection of a transaction (final). A read that matters, such
  as the cached-pool assertions, the gas floor, balances, allowances and
  the nonce, is retried across every alive endpoint and only then aborts
  with "all N/M endpoints failed to read X", which is a different message
  from "this is not the pool we expected".
- **Dust pools.** The token the guards were tuned on had three dust pools
  beside its ~$115k 1% pool. Filling one is ~100% impact. The dominance
  guard rejects them by ratio.

---

## Configuration — split by secrecy, hard rule

`.env` — **secrets and switches only**: `PRIVATE_KEY`, `BASE_RPC_URL`,
`ARC_MAINNET_HTTP_URL` (comma-separated failover list, first = primary),
`ARC_RPC_ROTATE_AFTER` (rotate after N consecutive transport failures,
default 3), `ARC_MAINNET_WSS_URL`, `ARC_RPC_MAX_RPS` (reader
rate, belongs to the endpoint: 5 for the public RPC, 50 with a private
one; `--rps` overrides per run), `ARC_RPC_RETRY_BASE_MS` (throttle
backoff base, default 400), `IRIS_API_URL`, `DISCORD_WH_EXECUTOR`,
`DISCORD_DRY_RUN`, `EXECUTION_DRY_RUN`,
`EXTRA_TOKENS` (comma-separated addresses: extra sell.ts positions beyond
`trade.targetToken` and `trade.tokens`' keys).
Never loaded by the radar (enforced in `packages/radar/test/unit/repo-layout.test.ts`:
no radar file may reference the executor package or `PRIVATE_KEY`, the env
bootstrap may only open files under the radar package, and a leaked key never
reaches its config).

`config/executor.json` — **everything else**:

- `route`: domains, chainIds, minFinalityThreshold, maxFeeMargin
- `trade`: targetToken, router, factories, feeTiers, defaultMinPoolDepthUsd,
  dominanceRatio, maxNotionalUsd, slippageBps, deadlineSec, approveOnFill,
  `tokens[addr] = { minPoolDepthUsd?, expectedFeeTier?, pool?, slippageBps?, hotkeys? }`
  (the last two are sell.ts per-position overrides, falling back to `sell.slippageBps`/`sell.hotkeys`)
- `sell`: hotkey→percent map, perTierMaxImpactBps (null = informational),
  confirmAbovePercent (accepted by the schema, not yet read by `sell.ts`
  [TODO]), slippageBps
- `timing`: attestationPollMs, attestationTimeoutSec, statePollMs,
  receiptTimeoutSec, fastTransferTargetMs
- `gas`: arcMaxFeePerGasGwei, arcPriorityFeeGwei, reserveTxCount,
  reserveGasPerTx
- `notify`: per-event enable flags

A JSON config must **never** contain a webhook URL, a private key, or a
kill-switch. `src/config.ts` scans the raw JSON before zod and aborts with
the failing path if a URL-shaped or 64-hex string, or a kill-switch key,
appears anywhere. The schema is strict: unknown keys fail.

Precedence: **CLI flag > env > json > built-in default.** `config.ts` is
the only module that reads `process.env` (static test). Startup prints a
3-line summary (mode, wallet, network + active RPC); `--verbose` prints
the full resolved config, secrets redacted. When the secrets scan rejects
the JSON, the full config is printed with the offending value masked so
the failing path is diagnosable.

---

## Discord

Webhook `DISCORD_WH_EXECUTOR` for every stage. Events, individually toggleable:

`bridge.burn_sent`, `bridge.attestation_pending`,
`bridge.attestation_complete`, `bridge.downgrade_detected`,
`bridge.mint_complete`, `trade.preflight`, `trade.fill`, `trade.sell`,
`error.abort`.

Embeds carry tx hash, explorer link, and elapsed time per stage.
`trade.fill` and `trade.sell` carry realised impact vs predicted.

`DISCORD_DRY_RUN=1` is the default: payloads logged, not POSTed, and
summarised at the end of every dry run.

**This module never pings.** No `@everyone`, no `ping_everyone`, no role
mentions, in any payload or code path; `allowed_mentions.parse` is always
empty. Enforced by `test/unit/no-ping.test.ts`, mirroring the radar's gate
test. A webhook failure never blocks or aborts a trade: the client queues,
honours 429 `retry_after`, retries 5xx, then logs.

---

## Status and limitations

- **Known issue: `run.ts --live --amount N` stops after the mint.**
  `--amount` sets the buy size to N as well as the bridge size
  (`src/run.ts:41`), but the CCTP protocol fee is deducted from what lands
  on Arc (quoted in `src/bridge.ts:44`), so the post-mint check
  `buy > minted` aborts before the buy (`src/run.ts:91-97`). The burn and
  mint have already happened and the USDC stays on Arc. Until this is
  fixed, use `--bridge-amount N` and omit `--buy-amount` to buy the full
  minted amount. [TODO: fix]
