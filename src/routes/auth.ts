// src/routes/auth.ts
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';

const router = Router();

// ---------------- helpers ----------------

/** Mint the next 8-digit public ID, e.g. "00000001". */
async function nextPublicId(client: any): Promise<string> {
  const r = await client.query(`SELECT nextval('public_id_seq') AS n`);
  const n = r.rows[0].n as string | number;
  return String(n).padStart(8, '0');
}

/** Random internal PK, since public_id is not the PK. */
function internalId(): string {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------------- POST /api/auth/register ----------------
// Everyone registers role-less via the public signup page.
// Roles are assigned later by permitted users in the admin panel.

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(6),
  nric: z.string().min(5).optional(),
  birthday: z.string().optional(),          // plain profile field, no ID coupling
  address: z.string().optional(),
  addressLat: z.number().optional(),
  addressLon: z.number().optional(),
  ecName: z.string().optional(),
  ecPhone: z.string().optional(),
  password: z.string().min(6),
});

router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }
  const d = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // duplicate email check
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [d.email.toLowerCase()]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already registered' });
    }

    const publicId = await nextPublicId(client);
    const passwordHash = await bcrypt.hash(d.password, 10);
    const id = internalId();

    await client.query(
      `INSERT INTO users
         (id, public_id, name, email, phone, birthday, nric,
          address_line1, address_lat, address_lon,
          ec_name, ec_phone, password_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
      [
        id,
        publicId,
        d.name,
        d.email.toLowerCase(),
        d.phone,
        d.birthday ?? null,
        d.nric ?? null,
        d.address ?? null,
        d.addressLat ?? null,
        d.addressLon ?? null,
        d.ecName ?? null,
        d.ecPhone ?? null,
        passwordHash,
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({ ok: true, userId: id, publicId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[register]', e);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// ---------------- POST /api/auth/login ----------------

router.post('/login', async (req: Request, res: Response) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

  try {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [parsed.data.email.toLowerCase()]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(parsed.data.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // roles for this user
    const roles = await pool.query(
      `SELECT ro.id, ro.name, ro.position FROM user_roles ur
       JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = $1`,
      [user.id]
    );

    return res.json({
      ok: true,
      user: {
        id: user.id,
        publicId: user.public_id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        birthday: user.birthday,
        nric: user.nric,
      },
      roles: roles.rows,
    });
  } catch (e) {
    console.error('[login]', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
