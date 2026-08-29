// src/routes/auth.ts
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { hashPassword } from '../utils/password';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  birthday: z.string().optional(),       // plain profile field, not part of the ID
  nric: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  city: z.string().optional(),
  postcode: z.string().optional(),
  state: z.string().optional(),
  address_geo_lat: z.number().optional(),
  address_geo_lon: z.number().optional(),
  ec_name: z.string().optional(),
  ec_phone: z.string().optional(),
  ec_relationship: z.string().optional(),
});

const birthdaySchema = z.object({
  userId: z.string(),
  birthday: z.string().min(8),
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid registration data', details: parsed.error.issues });
  }
  const d = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Duplicate email check
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [d.email]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // 2) Mint the next 8-digit public_id (global counter, all roles share it)
    const seq = await client.query("SELECT nextval('public_id_seq') AS n");
    const publicId = String(seq.rows[0].n).padStart(8, '0');

    // 3) Insert the user — role-less by design; roles are assigned later by an admin
    const passwordHash = await hashPassword(d.password);
    const internalId = 'u_' + Date.now().toString(36);

    const inserted = await client.query(
      `INSERT INTO users
        (id, public_id, name, email, password_hash, phone, birthday, nric,
         address_line1, address_line2, city, postcode, state,
         address_geo_lat, address_geo_lon,
         ec_name, ec_phone, ec_relationship, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       RETURNING id, public_id, name, email, created_at`,
      [
        internalId, publicId, d.name, d.email, passwordHash,
        d.phone ?? null, d.birthday ?? null, d.nric ?? null,
        d.address_line1 ?? null, d.address_line2 ?? null, d.city ?? null,
        d.postcode ?? null, d.state ?? null,
        d.address_geo_lat ?? null, d.address_geo_lon ?? null,
        d.ec_name ?? null, d.ec_phone ?? null, d.ec_relationship ?? null,
      ],
    );

    await client.query('COMMIT');
    const user = inserted.rows[0];
    return res.status(201).json({ user });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

authRouter.patch('/birthday', async (req, res) => {
  const parsed = birthdaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  try {
    const out = await pool.query(
      'UPDATE users SET birthday = $2 WHERE id = $1 RETURNING id, birthday',
      [parsed.data.userId, parsed.data.birthday],
    );
    if ((out.rowCount ?? 0) === 0) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: out.rows[0] });
  } catch (err) {
    console.error('[birthday] error:', err);
    return res.status(500).json({ error: 'Update failed' });
  }
});
