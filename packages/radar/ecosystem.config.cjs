// pm2 start ecosystem.config.cjs && pm2 logs arc-radar
module.exports = {
  apps: [
    {
      name: 'arc-radar',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      env: { NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
      autorestart: true,
      max_restarts: 50,
      exp_backoff_restart_delay: 1000,
      kill_timeout: 5000,
    },
  ],
};
