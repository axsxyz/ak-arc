import type { Channel } from '../config/env.js';
import type { Signal } from './types.js';

/**
 * The ping gate. This file is the ONLY place allowed to set `ping_everyone: true`
 * (enforced by test/alerts/static-ping.test.ts). False @everyone is a P0 bug.
 */
export interface Decision {
  channel: Channel | undefined; // undefined = logs only
  ping_everyone: boolean;
  reason: string;
}

/** Non-hard-rule signals that may still land in #alerts, never with a ping. */
const ALERTS_NO_PING = new Set<Signal['type']>(['MISSING_ON_CHAIN', 'BRIDGE_FLOW', 'BRIDGE_INFLOW', 'BRIDGE_OUTFLOW']);

export function decide(s: Signal, pingEnabled: boolean): Decision {
  if (s.channel !== 'alerts') {
    return { channel: s.channel, ping_everyone: false, reason: 'specialty channel' };
  }
  if (!s.hardRule) {
    if (ALERTS_NO_PING.has(s.type)) return { channel: 'alerts', ping_everyone: false, reason: 'alerts (no-ping type)' };
    return { channel: s.fallbackChannel, ping_everyone: false, reason: `refused: ${s.type} is not a hard rule` };
  }
  if (s.hardRule !== s.type) {
    return { channel: s.fallbackChannel, ping_everyone: false, reason: 'refused: hardRule/type mismatch' };
  }
  if (!s.evidence.usdCertain || !s.evidence.trusted) {
    return {
      channel: s.fallbackChannel,
      ping_everyone: false,
      reason: `downgraded: usdCertain=${s.evidence.usdCertain} trusted=${s.evidence.trusted}`,
    };
  }
  if (!pingEnabled) return { channel: 'alerts', ping_everyone: false, reason: 'hard rule; ALERTS_PING_ENABLED=0' };
  return { channel: 'alerts', ping_everyone: true, reason: `hard rule ${s.hardRule}` };
}
