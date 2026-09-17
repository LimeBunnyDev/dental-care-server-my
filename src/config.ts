/**
 * Centralized config. Loads .env once, exposes a typed object.
 * Import this instead of touching process.env anywhere else.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required env var: ${name}`);
    console.error(`[config] Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret:   required('JWT_SECRET'),
  port:        Number(optional('PORT', '4000')),
  webOrigin:   optional('WEB_ORIGIN', 'http://localhost:8081'),
  nodeEnv:     optional('NODE_ENV', 'development'),
  superAdminUsername: optional('SUPER_ADMIN_USERNAME', '').toLowerCase(),
  isProd:      optional('NODE_ENV', 'development') === 'production',
} as const;

export type Config = typeof config;