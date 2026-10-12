/**
 * npm run test:webhooks:dry — build one sample embed per channel and print it.
 * Only POSTs when ALLOW_LIVE_WEBHOOKS=1. With --once, a marker file prevents re-sending (design: "send a test embed once, then disable").
 */
import '../config/load-env.js'; // must stay first
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CHANNELS, loadConfig } from '../config/env.js';
import { makePayload, WebhookSink } from '../discord/client.js';
import { buildEmbed } from '../discord/embeds.js';
import { decide } from '../score/gate.js';
import type { Signal } from '../score/types.js';

const cfg = loadConfig(process.env);
const live = process.env.ALLOW_LIVE_WEBHOOKS === '1';
const once = process.argv.includes('--once');
const marker = path.resolve('data', `.webhooks-tested-${cfg.network.name}`);

async function main() {
  if (live && once && fs.existsSync(marker)) {
    console.log(`test embeds already sent (${marker}); delete the file to resend.`);
    return;
  }
  const now = Date.now();
  const sink = new WebhookSink(cfg.webhooks, !live, pino({ level: 'silent' }));
  for (const channel of CHANNELS) {
    const s: Signal = {
      type: channel === 'alerts' ? 'MISSING_ON_CHAIN' : 'MAJOR_DIGEST',
      channel,
      severity: 'info',
      dedupeKey: `WEBHOOK_TEST|${channel}`,
      eventTimeMs: now,
      evidence: { usdCertain: false, trusted: true },
      compact: true,
      title: `WEBHOOK_TEST · #${channel}`,
      description: `Arc Radar webhook wiring test (${cfg.network.label}). No signal. No ping.`,
    };
    const decision = decide(s, false); // test embeds never ping, even in #alerts
    const payload = makePayload(channel, buildEmbed(s, cfg.network, now), decision, cfg.discordUsername);
    const configured = Boolean(cfg.webhooks[channel]);
    console.log(`#${channel} webhook=${configured ? 'configured' : 'MISSING'} mode=${live ? 'LIVE POST' : 'dry'}`);
    if (!live) console.log(JSON.stringify(payload, null, 2));
    else if (configured) await sink.send({ channel, payload });
  }
  if (live && once) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  }
  if (!live) console.log('\ndry run: nothing sent. Set ALLOW_LIVE_WEBHOOKS=1 to POST.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
