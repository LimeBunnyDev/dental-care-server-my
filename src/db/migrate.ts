/**
 * Idempotent schema migration.
 * Run with:   npm run db:migrate
 */

import { pool } from './pool';

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  phone           TEXT NOT NULL,
  nric            TEXT NOT NULL,
  address_line1   TEXT NOT NULL,
  address_line2   TEXT,
  city            TEXT NOT NULL,
  postcode        TEXT NOT NULL,
  state           TEXT NOT NULL,
  ec_name         TEXT NOT NULL,
  ec_phone        TEXT NOT NULL,
  ec_relationship TEXT,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'patient',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS dentists (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  title        TEXT NOT NULL,
  specialty    TEXT NOT NULL,
  bio          TEXT NOT NULL,
  initials     TEXT NOT NULL,
  accent_color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dentist_id  TEXT NOT NULL REFERENCES dentists(id) ON DELETE RESTRICT,
  date        DATE NOT NULL,
  time        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'upcoming',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointments_user_idx ON appointments (user_id);
CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments (date);

CREATE TABLE IF NOT EXISTS availability_overrides (
  dentist_id TEXT NOT NULL REFERENCES dentists(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  slots      JSONB NOT NULL,
  PRIMARY KEY (dentist_id, date)
);
`;

async function main() {
  console.log('[migrate] applying schema…');
  await pool.query(SQL);
  console.log('[migrate] done.');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
