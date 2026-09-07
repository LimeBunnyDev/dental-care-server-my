// src/routes/auth.ts — v3: 8-digit public_id, no role/invite codes at signup
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  nric: z.string().optional(),
  birthday: z.string().optional(), // YYYY-MM-DD — profile field only, NOT part of the ID
  address: z.string().optional(),  // stored into users.address_line1
  addressLat: z.number().optional(),
  addressLon: z.number().optional(),
  ecName: z.string().optional(),
  ecPhone: z.string().optional(),
});

// POST /api/auth/register
// Everyone registers role-less. public_id = next value of global 8-digit counter.
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid registration data', details: parsed.error.flatten() });
  }
  const d = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Duplicate email check
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [d.email.toLowerCase()]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // 2) Mint the next 8-digit public_id
    const seq = await client.query(`SELECT nextval('public_id_seq') AS n`);
    const publicId = String(seq.rows[0].n).padStart(8, '0');

    // 3) Insert the user (role-less; roles assigned later via admin panel)
    const internalId = 'u_' + Date.now().toString(36);
    const passwordHash = await bcrypt.hash(d.password, 10);
    const inserted = await client.query(
      `INSERT INTO users
         (id, public_id, name, email, password_hash, phone, nric, birthday,
          address_line1, address_lat, address_lon, ec_name, ec_phone, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       RETURNING id, public_id, name, email`,
      [
        internalId, publicId, d.name, d.email.toLowerCase(),
        passwordHash,
        d.phone ?? null, d.nric ?? null, d.birthday ?? null,
        d.address ?? null, d.addressLat ?? null, d.addressLon ?? null,
        d.ecName ?? null, d.ecPhone ?? null,
      ]
    );

    await client.query('COMMIT');
    const u = inserted.rows[0];
    return res.status(201).json({ user: { id: u.id, public_id: u.public_id, name: u.name, email: u.email } });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

export default router;
