import { describe, expect, it } from 'vitest';
import { decodeLog, parseRpcLog, TOPICS } from '../../src/decode/index.js';
import { listScenarios, loadScenario } from '../../src/testing/runner.js';
import { classifyBytecode } from '../../src/tools/discover-factories.js';

describe('topic hashes', () => {
  it('Uniswap V3 topics equal the PUSH32 topics found in TollyPad bytecode on Arc testnet (2026-09-13)', () => {
    expect(TOPICS.v3PoolCreated).toBe('0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118');
    expect(TOPICS.v3Swap).toBe('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
    expect(TOPICS.v3Mint).toBe('0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde');
    expect(TOPICS.v3Burn).toBe('0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c');
  });
  it('well-known ERC-20 / V2 topics', () => {
    expect(TOPICS.transfer).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    expect(TOPICS.v2PairCreated).toBe('0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9');
    expect(TOPICS.v2Swap).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
    expect(TOPICS.v2Sync).toBe('0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
  });
});

describe('decode every fixture log', () => {
  for (const name of listScenarios()) {
    it(name, () => {
      const s = loadScenario(name);
      const logs = [...(s.chainLogs ?? []), ...s.steps.flatMap((st) => (st.op === 'logs' ? st.logs : []))];
      for (const l of logs) {
        const ev = decodeLog(parseRpcLog(l));
        expect(ev, `undecodable log in ${name}: ${l.topics[0]}`).toBeDefined();
      }
    });
  }
});

describe('decode semantics', () => {
  const s = loadScenario('02-swaps');
  const logs = s.steps.flatMap((st) => (st.op === 'logs' ? st.logs : [])).map(parseRpcLog);
  it('PoolCreated', () => {
    const ev = decodeLog(logs[0]!);
    expect(ev).toMatchObject({ kind: 'pool_created', dex: 'univ3', factory: '0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b', fee: 10000 });
  });
  it('V3 buy: USDC into pool (+), tokens out (-)', () => {
    const ev = decodeLog(logs[1]!);
    if (ev?.kind !== 'swap') throw new Error('not swap');
    expect(ev.amount0).toBe(1_200_000_000n);
    expect(ev.amount1 < 0n).toBe(true);
  });
  it('V3 sell: USDC out (-)', () => {
    const ev = decodeLog(logs[2]!);
    if (ev?.kind !== 'swap') throw new Error('not swap');
    expect(ev.amount0).toBe(-800_000_000n);
  });
  it('unknown / malformed logs return undefined', () => {
    expect(decodeLog({ ...logs[1]!, topics: ['0x' + '11'.repeat(32)] as `0x${string}`[] })).toBeUndefined();
    expect(decodeLog({ ...logs[1]!, data: '0x1234' })).toBeUndefined();
    expect(decodeLog({ ...logs[1]!, topics: [] })).toBeUndefined();
  });
  it('ERC-721 Transfer (4 topics) is not treated as ERC-20', () => {
    const t = TOPICS.transfer;
    const z = ('0x' + '0'.repeat(64)) as `0x${string}`;
    expect(decodeLog({ ...logs[1]!, topics: [t, z, z, z], data: '0x' })).toBeUndefined();
  });
});

describe('CCTP decode', () => {
  const s = loadScenario('18-bridge-cctp');
  const logs = s.steps.flatMap((st) => (st.op === 'logs' ? st.logs : [])).map(parseRpcLog);
  it('MessageReceived -> bridge_mint (caller, nonce, sourceDomain)', () => {
    const ev = decodeLog(logs[1]!);
    expect(ev).toMatchObject({ kind: 'bridge_mint', caller: '0x7070000000000000000000000000000000007070', sourceDomain: 6 });
  });
  it('mint Transfer(0x0 -> recipient) decodes as a plain transfer, emitter = system emitter', () => {
    const ev = decodeLog(logs[0]!);
    // 18-dec native, not the 6-dec ERC-20 mirror scale: $50,000 = 50_000n * 10n ** 18n (see pipeline.ts onBridgeInflow's fix).
    expect(ev).toMatchObject({ kind: 'transfer', emitter: '0xfffffffffffffffffffffffffffffffffffffffe', from: '0x0000000000000000000000000000000000000000', to: '0x2222000000000000000000000000000000002222', value: 50_000n * 10n ** 18n });
  });
  it('DepositForBurn -> bridge_burn (burnToken, amount, depositor, destinationDomain)', () => {
    const ev = decodeLog(logs[logs.length - 1]!);
    expect(ev).toMatchObject({ kind: 'bridge_burn', burnToken: '0x3600000000000000000000000000000000000000', amount: 50_000_000_000n, depositor: '0xb121000000000000000000000000000000000b12', destinationDomain: 6 });
  });
});

describe('factory discovery bytecode classifier', () => {
  const pad = (t: string) => `0x6080${t.slice(2)}60ff` as `0x${string}`;
  it('classifies by embedded topics', () => {
    expect(classifyBytecode('0x')).toBe('no-code');
    expect(classifyBytecode(pad(TOPICS.v3PoolCreated))).toBe('univ3-factory');
    expect(classifyBytecode(pad(TOPICS.v2PairCreated))).toBe('univ2-factory');
    expect(classifyBytecode(pad(TOPICS.padGraduated))).toBe('pad-like');
    expect(classifyBytecode('0x60806040')).toBe('contract');
  });
});
