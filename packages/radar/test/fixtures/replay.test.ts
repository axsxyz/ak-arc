import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR, listScenarios, loadScenario, runScenario, summarize } from '../../src/testing/runner.js';

/** Replay recorded (ABI-encoded) logs → expected Discord payloads. No network. Snapshots under fixtures/expected/. */
describe('fixture replay → Discord payload snapshots', () => {
  for (const name of listScenarios()) {
    it(name, async () => {
      const run = await runScenario(loadScenario(name));
      const json = JSON.stringify(summarize(run), null, 2) + '\n';
      await expect(json).toMatchFileSnapshot(path.join(FIXTURES_DIR, 'expected', `${name}.json`));
    });
  }
});
