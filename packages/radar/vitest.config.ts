import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests never touch the network or Discord.
    env: { DISCORD_DRY_RUN: '1', LOG_LEVEL: 'silent', ARC_NETWORK: 'testnet' },
    testTimeout: 20_000,
  },
});
