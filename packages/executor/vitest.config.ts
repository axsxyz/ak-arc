import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests never touch the network, Discord, or the signing key.
    env: { DISCORD_DRY_RUN: '1', EXECUTION_DRY_RUN: '1' },
    testTimeout: 20_000,
  },
});
