import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db';

const router = Router();

const RegisterSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(30).optional().nullable(),
  nric: z.string().max(20).optional().nullable(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  password: z.string().min(6).max(100),
  addressGeo: z
    .object({ lat: z.number(), lon: z.number(), address: z.string().optional() })
    .optional()
    .nullable(),
});

// POST /api/auth/register
// Creates a user with a global sequential 8-digit public_id (00000001...).
// New users get NO role. Roles are assigned later via the admin panel.
router.post('/register', async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  }
  const { name, email, phone, nric, birthday, password, addressGeo } = parsed.data;

  const client = await pool.connect();
  try {
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if ((dup.rowCount ?? 0) > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    await client.query('BEGIN');

    // Mint the next 8-digit public_id
    const seq = await client.query(`SELECT LPAD(nextval('public_id_seq')::text, 8, '0') AS pid`);
    const publicId: string = seq.rows[0].pid;

    // Hash password (Node 20+ has bcrypt-free scrypt; adjust if your project uses bcrypt)
    const crypto = await import('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const passwordHash = `scrypt:${salt}:${hash}`;

    // NOTE: adjust column list to your users table if it differs.
    const inserted = await client.query(
      `INSERT INTO users (id, name, email, phone, nric, birthday, password_hash, public_id, latitude, longitude, address_text, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING id, name, email, public_id, created_at`,
      [
        name,
        email.toLowerCase(),
        phone ?? null,
        nric ?? null,
        birthday ?? null,
        passwordHash,
        publicId,
        addressGeo?.lat ?? null,
        addressGeo?.lon ?? null,
        addressGeo?.address ?? null,
      ]
    );

    await client.query('COMMIT');
    const u = inserted.rows[0];
    return res.status(201).json({
      user: { id: u.id, name: u.name, email: u.email, publicId: u.public_id },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

export default router;
