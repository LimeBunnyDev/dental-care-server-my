/**
 * Wipes ALL data (destructive — for development only).
 */

import { pool } from './pool';

async function main() {
  console.warn('[reset] dropping all tables (this is destructive)…');
  await pool.query(`
    DROP TABLE IF EXISTS availability_overrides CASCADE;
    DROP TABLE IF EXISTS appointments CASCADE;
    DROP TABLE IF EXISTS dentists CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
  console.warn('[reset] done. Run "npm run db:migrate && npm run db:seed" next.');
  await pool.end();
}

main().catch((err) => {
  console.error('[reset] failed', err);
  process.exit(1);
});
