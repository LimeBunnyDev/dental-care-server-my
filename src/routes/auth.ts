// dental-care-server/src/routes/auth.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { hashPassword } from '../utils/password';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(6).optional(),
  birthday: z.string().optional(),          // YYYY-MM-DD; plain profile field now
  nric: z.string().optional(),
  address: z.string().optional(),
  addressLat: z.number().optional(),
  addressLon: z.number().optional(),
  ecName: z.string().optional(),
  ecPhone: z.string().optional(),
  password: z.string().min(6),
});

// POST /api/auth/register — open signup, NO role, 8-digit public_id.
router.post('/register', async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid signup data', details: parsed.error.flatten().fieldErrors });
    }
    const d = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Duplicate email check
      const dup = await client.query('SELECT id FROM users WHERE email = $1', [d.email.toLowerCase()]);
      if ((dup.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Mint the next 8-digit public_id atomically
      const seqRes = await client.query("SELECT nextval('public_id_seq') AS n");
      const publicId = String(seqRes.rows[0].n).padStart(8, '0');

      const passwordHash = await hashPassword(d.password);
      const internalId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

      const insert = await client.query(
        `INSERT INTO users
           (id, public_id, name, email, phone, birthday, nric,
            address_line1, address_lat, address_lon,
            ec_name, ec_phone, password_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         RETURNING id, public_id, name, email`,
        [
          internalId,
          publicId,
          d.name,
          d.email.toLowerCase(),
          d.phone ?? null,
          d.birthday && d.birthday.length >= 8 ? d.birthday : null,
          d.nric ?? null,
          d.address ?? null,
          d.addressLat ?? null,
          d.addressLon ?? null,
          d.ecName ?? null,
          d.ecPhone ?? null,
          passwordHash,
        ],
      );

      await client.query('COMMIT');
      const u = insert.rows[0];
      return res.status(201).json({ user: { id: u.id, publicId: u.public_id, name: u.name, email: u.email } });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[register] error:', err?.message ?? err);
    // Friendly message for a missing column so you know instantly if the DB is behind
    if (String(err?.message).includes('public_id')) {
      return res.status(500).json({ error: 'Database missing public_id — run the migration SQL first' });
    }
    return res.status(500).json({ error: 'Registration failed' });
  }
});

export default router;
