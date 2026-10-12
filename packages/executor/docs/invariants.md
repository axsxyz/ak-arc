# Executor invariants

These are correctness invariants, not style preferences: violating any of
them can lose funds. Each one is either enforced by code and tests or
documented here as an operating constraint.

## Shared code with the radar

The radar package already solves most of the chain-reading problems, with
tests. The executor imports it rather than re-deriving anything.

| Need | Where it lives |
|---|---|
| 6-dec ERC-20 mirror vs 18-dec native USDC | `packages/radar/src/math` (golden vectors in `test:unit`) |
| Rate-limited RPC reader, chainId assert, no cached "absent" | `packages/radar/src/rpc` |
| Resolve a token's deepest trusted pool + USDC depth | `PoolRegistry` + allowlisted-factory round trip |
| Price impact: `2 × fee + size / (2 × depth)` | `packages/radar/src/score/paper.ts` |

The impact preflight is `paper.ts`'s cost model called with the real trade
size instead of `PAPER_SIZE_USD`. There is exactly one cost model.

## Money

- **Decimals.** Arc fees and native value use 18 decimals; the USDC ERC-20
  interface uses 6. All conversions go through `packages/radar/src/math`.
  No floating-point `number` near money.
- **Mainnet CCTP addresses are discovered, not hardcoded.** They are found
  on chain (`discover:onchain` once the MessageTransmitter emits), asserted,
  and the process fails loudly on mismatch. Testnet addresses are shape
  references, never fallbacks.
- **chainId mismatch is a hard abort** (exit 2), never a warning or retry.

## Execution

- **Buy only in the deepest trusted pool.** Tokens on Arc commonly have
  dust pools (< $0.001 USDC) beside a deep one; filling a dust pool is ~100%
  impact. The pool's factory must be allowlisted and its USDC depth must
  exceed the floor before anything is signed. Dust pools never price a
  major and never fill one either.
- **Nonce.** One wallet is signer, mintRecipient and swapper. An explicit
  single-flight counter, incremented in memory. `eth_getTransactionCount`
  is never called between the mint and the buy. On revert the nonce is
  consumed and any pre-signed follow-up is invalid: re-sign.
- **Blocklist reverts produce no receipt.** "No receipt" and "reverted with
  receipt" are distinct outcomes; the receipt wait tells them apart.
- Sends to `address(0)` revert on Arc rather than succeeding.
- Raw viem on the hot path. The SDK resolves config; it does not execute.

## Strategy constraint

The binding constraint is **pool depth, not latency**. The pool is thin and
it is also the exit. Missing the fill beats eating heavy impact both ways.
Impact is **informational, never blocking** (design decision 2026-09-15):
the operator owns price decisions and sizes by hand; the module owns
correctness. The guards are the per-token depth floor and the dominance
ratio (deepest tier ≥ 20× the runner-up), plus `minOut` from
`slippageBps`. Gas is not optimised: it is ~0.005 USDC per call and is not
the problem.

## Safety

- `--dry-run` is the default. `--live` requires an explicit `--amount`.
- **This module never pings.** `@everyone` belongs to the radar's gate and
  to nothing else. The executor logs locally; if an alert is needed, the
  radar emits it.
- The private key lives in `packages/executor/.env` only. Never in a
  profile, never in a shared `.env`, never read by the radar.
- Single-instance lockfile per wallet. No double-spend across any restart
  path.

## Scope

Each stage runs once and exits. No state machine, no disk journal, no
metrics pipeline, no retry framework, no config system beyond
`src/config.ts`. Timestamped console logs. Infrastructure beyond this is
deliberately out of scope.
