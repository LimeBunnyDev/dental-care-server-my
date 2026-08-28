// src/routes/auth.ts
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nric: z.string().max(20).optional(),
  address: z.string().max(500).optional(),
  ecName: z.string().max(120).optional(),
  ecPhone: z.string().max(40).optional(),
  password: z.string().min(6).max(100),
});

// Simple hash placeholder — replace with bcrypt when you're ready.
function hashPassword(pw: string): string {
  return 'sha256:' + Buffer.from('pw:' + pw).toString('base64');
}

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }
  const d = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Duplicate email check
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [d.email]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // 2. Mint next 8-digit public_id
    const seq = await client.query("SELECT nextval('public_id_seq') AS v");
    const publicId = String(seq.rows[0].v).padStart(8, '0');

    // 3. Insert user (no role — roles assigned later by admins)
    const id = 'u_' + Date.now().toString(36);
    const insert = await client.query(
      `INSERT INTO users
         (id, public_id, name, email, phone, birthday, nric, address,
          ec_name, ec_phone, password_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       RETURNING id, public_id, name, email`,
      [
        id, publicId, d.name, d.email,
        d.phone ?? null, d.birthday ?? null, d.nric ?? null, d.address ?? null,
        d.ecName ?? null, d.ecPhone ?? null, hashPassword(d.password),
      ]
    );

    await client.query('COMMIT');
    const u = insert.rows[0];
    return res.status(201).json({ user: { id: u.id, publicId: u.public_id, name: u.name, email: u.email } });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err.message);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

router.patch('/birthday', async (req, res) => {
  // Birthday is now a plain profile field — handled by the profile routes.
  return res.status(501).json({ error: 'Use profile update endpoint' });
});

export default router;
