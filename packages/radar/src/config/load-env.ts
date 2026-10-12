/**
 * Environment bootstrap for every entrypoint (import FIRST, before anything that reads process.env).
 *
 * Precedence (highest wins):
 *   1. real shell / cross-env variables
 *   2. profile file config/profiles/<ARC_PROFILE>.env   (non-secret presets, e.g. mainnet-poll)
 *   3. .env                                              (secrets + your local defaults)
 *
 * Profiles must never contain secrets (enforced by test/unit/repo-layout.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export function applyEnv(env: NodeJS.ProcessEnv, cwd: string, readFile: (p: string) => string | undefined = defaultRead): string | undefined {
  const shellKeys = new Set(Object.keys(env));
  const dotenvText = readFile(path.join(cwd, '.env'));
  if (dotenvText !== undefined) {
    for (const [k, v] of Object.entries(dotenv.parse(dotenvText))) if (!shellKeys.has(k)) env[k] = v;
  }
  const profile = env.ARC_PROFILE?.trim();
  if (!profile) return undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) throw new Error(`ARC_PROFILE must be a simple name like "mainnet-poll", got "${profile}"`);
  const file = path.join(cwd, 'config', 'profiles', `${profile}.env`);
  const text = readFile(file);
  if (text === undefined) throw new Error(`ARC_PROFILE=${profile}: ${path.relative(cwd, file)} not found`);
  for (const [k, v] of Object.entries(dotenv.parse(text))) if (!shellKeys.has(k)) env[k] = v;
  return file;
}

function defaultRead(p: string) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
}

export const loadedProfile = applyEnv(process.env, process.cwd());
