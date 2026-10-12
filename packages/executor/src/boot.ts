/**
 * boot — the shared entry sequence for every CLI: load + print config,
 * build clients, wire Discord, hook aborts, take the single-instance lock.
 */

import type { Address } from 'viem';
import { acquireLock, makeCtx, type Ctx } from './chain.js';
import { loadConfig, printConfig, type Config } from './config.js';
import { C, setAbortHook } from './log.js';
import { COLORS, embed, Notifier } from './notify.js';

export interface Boot {
  cfg: Config;
  ctx: Ctx;
  notifier: Notifier;
  release: () => void;
}

export function boot(name: string, argv: string[], o: { lock?: boolean } = {}): Boot {
  let cfg: Config;
  try {
    cfg = loadConfig({ argv });
  } catch (e) {
    console.error(`\n${C.red('CONFIG')} ${(e as Error).message}\n`);
    process.exit(2);
  }
  const ctx = makeCtx(cfg);
  console.log(`\n${C.bold(`executor ${name}`)}  ${cfg.live ? C.bold('LIVE') : C.dim('DRY RUN')}\n`);
  printConfig(cfg, { wallet: ctx.account.address, rpcHost: ctx.pool.describe() });
  const notifier = new Notifier({ webhook: cfg.webhook, dryRun: cfg.discordDryRun, enabled: cfg.notify });
  setAbortHook(async (msg) => {
    await notifier.emit('error.abort', embed({ title: `abort: ${name}`, color: COLORS.error, fields: [{ name: 'reason', value: msg.slice(0, 1000) }] }));
    await notifier.flush();
  });
  const release = cfg.live && o.lock !== false ? acquireLock(process.cwd(), ctx.account.address) : () => undefined;
  return { cfg, ctx, notifier, release };
}

/** Dry-run summary: every payload the run would have POSTed. */
export function printDryRunPayloads(notifier: Notifier, discordDryRun = true): void {
  if (!notifier.emitted.length) return;
  console.log(`\n${C.bold(discordDryRun ? 'Discord payloads (dry-run, not POSTed)' : 'Discord payloads (POSTed to the webhook)')}`);
  for (const { event, payload } of notifier.emitted) console.log(`  ${event}: ${JSON.stringify(payload.embeds[0]?.fields.map((f) => `${f.name}=${f.value.replace(/\n/g, ' | ')}`))}`);
  console.log('');
}

export const asAddress = (a: string) => a.toLowerCase() as Address;
