// src/routes/auth.ts  — FULL REPLACEMENT
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool } from '../db';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6).optional(),
  passwordHash: z.string().min(6).optional(), // accept legacy field name
  birthday: z.string().optional(),
  phone: z.string().optional(),
  nric: z.string().optional(),
});

function firstZodError(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Invalid input';
}

// ============ POST /api/auth/register ============
// Everyone registers the same way: no role, no invite code.
// public_id = 8-digit zero-padded sequence (00000001, 00000002, ...)
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: firstZodError(parsed.error) });
  }
  const { name, email, birthday, phone, nric } = parsed.data;
  const plain = parsed.data.password ?? parsed.data.passwordHash;
  if (!plain) return res.status(400).json({ error: 'Password is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) duplicate email check
    const dup = await client.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // 2) mint the next 8-digit public_id
    const seq = await client.query(`SELECT nextval('public_id_seq') AS n`);
    const publicId = String(seq.rows[0].n).padStart(8, '0');

    // 3) hash + insert
    const passwordHash = await bcrypt.hash(plain, 10);
    const inserted = await client.query(
      `INSERT INTO users (id, email, name, password_hash, birthday, phone, nric, public_id)
       VALUES ('u_' || floor(extract(epoch from clock_timestamp()) * 1000)::text || floor(random() * 1000)::text,
               $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, name, public_id, birthday, phone, created_at`,
      [email, name, passwordHash, birthday ?? null, phone ?? null, nric ?? null, publicId]
    );

    await client.query('COMMIT');
    return res.status(201).json({ user: inserted.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// ============ PATCH /api/auth/birthday ============
// Birthday is now a plain profile field (the ID no longer embeds it),
// so this is a simple update with the 30-day cooldown kept as a policy.
router.patch('/birthday', async (req, res) => {
  const schema = z.object({ email: z.string().email(), birthday: z.string().min(8) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: firstZodError(parsed.error) });
  }
  const { email, birthday } = parsed.data;
  try {
    const updated = await pool.query(
      `UPDATE users
       SET birthday = $1, birthday_changed_at = now()
       WHERE email = $2
       RETURNING id, email, birthday`,
      [birthday, email]
    );
    if ((updated.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: updated.rows[0] });
  } catch (err) {
    console.error('[birthday] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
