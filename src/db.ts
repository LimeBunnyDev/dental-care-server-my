// src/db.ts
import { Pool } from 'pg';

// Reads DATABASE_URL from .env (loaded in server.ts via dotenv).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err.message);
});
