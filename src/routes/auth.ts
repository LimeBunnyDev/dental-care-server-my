// src/routes/auth.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db'; // <-- if your pool export lives elsewhere, fix ONLY this line

const router = Router();

// ---------- helpers ----------

function hashPassword(plain: string): string {
  // Keep whatever hashing your project already uses. If you had bcrypt,
  // swap this for bcrypt.hash(plain, 10). Simple sha256 placeholder:
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function verifyPassword(plain: string, hash: string): boolean {
  return hashPassword(plain) === hash;
}

// Mint the next 8-digit public ID: "00000001", "00000002", ...
async function nextPublicId(): Promise<string> {
  const r = await pool.query<{ nextval: string }>(
    "SELECT nextval('public_id_seq') AS nextval"
  );
  return String(r.rows[0].nextval).padStart(8, '0');
}

// ---------- schemas ----------

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  birthday: z.string().optional(),          // plain profile field now
  nric: z.string().optional(),
  address: z.string().optional(),
  addressLat: z.number().optional(),
  addressLon: z.number().optional(),
  ecName: z.string().optional(),
  ecPhone: z.string().optional(),
});

// ---------- routes ----------

// POST /api/auth/register
// Everyone registers role-less. public_id = 8-digit global counter.
router.post('/register', async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid registration payload', details: parsed.error.flatten() });
    }
    const d = parsed.data;

    const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1', [d.email]);
    if ((emailCheck.rowCount ?? 0) > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const publicId = await nextPublicId();
    const passwordHash = hashPassword(d.password);

    const insert = await pool.query(
      `INSERT INTO users
        (public_id, name, email, password_hash, phone, birthday, nric,
         address, address_lat, address_lon, ec_name, ec_phone, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       RETURNING id, public_id, name, email`,
      [
        publicId, d.name, d.email, passwordHash,
        d.phone ?? null, d.birthday ?? null, d.nric ?? null,
        d.address ?? null, d.addressLat ?? null, d.addressLon ?? null,
        d.ecName ?? null, d.ecPhone ?? null,
      ]
    );

    const user = insert.rows[0];
    return res.status(201).json({ user });
  } catch (err: any) {
    console.error('[register] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const r = await pool.query(
      'SELECT id, public_id, name, email, password_hash FROM users WHERE email = $1',
      [email]
    );
    if ((r.rowCount ?? 0) === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const u = r.rows[0];
    if (!verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    return res.json({
      user: { id: u.id, public_id: u.public_id, name: u.name, email: u.email },
    });
  } catch (err: any) {
    console.error('[login] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/roles/:userId  — list a user's roles (for profile page)
router.get('/roles/:userId', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT ro.id, ro.name, ro.color, ro.position
         FROM user_roles ur
         JOIN roles ro ON ro.id = ur.role_id
        WHERE ur.user_id = $1
        ORDER BY ro.position DESC`,
      [req.params.userId]
    );
    return res.json({ roles: r.rows });
  } catch (err: any) {
    console.error('[roles] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Failed to load roles' });
  }
});

export default router;
