// src/routes/auth.ts
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(6).max(40),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  passwordHash: z.string().min(6),
  addressGeo: z
    .object({ lat: z.number(), lon: z.number() })
    .optional()
    .nullable(),
});

// POST /api/auth/register
// Everyone registers role-less. Mints a global 8-digit public_id (00000001...).
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const { name, email, phone, birthday, passwordHash, addressGeo } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Duplicate email check
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Mint the next 8-digit public_id
    const seqRes = await client.query(`SELECT LPAD(nextval('public_id_seq')::text, 8, '0') AS public_id`);
    const publicId: string = seqRes.rows[0].public_id;

    // Insert user (no role — roles are assigned later via admin panel)
    const insert = await client.query(
      `INSERT INTO users (id, public_id, name, email, phone, birthday, password_hash, address_geo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING id, public_id, name, email`,
      [
        `u_${Date.now().toString(36)}`,
        publicId,
        name,
        email,
        phone,
        birthday,
        passwordHash,
        addressGeo ? JSON.stringify(addressGeo) : null,
      ]
    );

    await client.query('COMMIT');
    const u = insert.rows[0];
    return res.status(201).json({ user: { id: u.id, publicId: u.public_id, name: u.name, email: u.email } });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err?.message || err);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

export default router;
