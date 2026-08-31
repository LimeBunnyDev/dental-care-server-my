import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

const router = Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// POST /api/auth/register
// 8-digit public_id model: every new user gets the next number from the
// global public_id_seq counter. No role at signup (roles assigned later by
// permitted staff). Invite codes and birthday-derived IDs are retired.
// ---------------------------------------------------------------------------
const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(6),
  nric: z.string().min(12).max(14).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  password: z.string().min(6),
  addressGeo: z.object({ lat: z.number(), lon: z.number() }).optional(),
  address: z.string().optional(),
});

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const { name, email, phone, nric, birthday, password, addressGeo, address } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Duplicate email check
    const dup = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // 2) Mint the next 8-digit public_id atomically
    const seqRes = await client.query(`SELECT nextval('public_id_seq') AS n`);
    const publicId = String(seqRes.rows[0].n).padStart(8, '0');

    // 3) Hash password + internal surrogate id
    const passwordHash = await bcrypt.hash(password, 10);
    const internalId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // 4) Insert user (role is NULL — no role at signup)
    const insert = await client.query(
      `INSERT INTO users (id, public_id, name, email, phone, nric, birthday, password_hash, address_geo, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       RETURNING id, public_id, name, email, role, created_at`,
      [internalId, publicId, name, email.toLowerCase(), phone, nric ?? null, birthday, passwordHash,
       addressGeo ? JSON.stringify({ lat: addressGeo.lat, lon: addressGeo.lon, label: address ?? null }) : null]
    );

    await client.query('COMMIT');
    const user = insert.rows[0];
    return res.status(201).json({
      user: { id: user.id, publicId: user.public_id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[register] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login — verify credentials, return user + roles
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { email, password } = parsed.data;

  try {
    const userRes = await pool.query(
      'SELECT id, public_id, name, email, password_hash, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if ((userRes.rowCount ?? 0) === 0) return res.status(401).json({ error: 'Invalid email or password' });
    const u = userRes.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Fetch the user's roles + merged permissions
    const rolesRes = await pool.query(
      `SELECT r.id, r.name, r.color, r.position,
              COALESCE(array_agg(rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permissions
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE ur.user_id = $1
       GROUP BY r.id, r.name, r.color, r.position
       ORDER BY r.position DESC`,
      [u.id]
    );

    return res.json({
      user: {
        id: u.id,
        publicId: u.public_id,
        name: u.name,
        email: u.email,
        role: u.role,
        roles: rolesRes.rows,
      },
    });
  } catch (err) {
    console.error('[login] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — session check
// ---------------------------------------------------------------------------
router.get('/me', async (req, res) => {
  const email = String(req.query.email ?? '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'email query param required' });
  try {
    const userRes = await pool.query(
      'SELECT id, public_id, name, email, role FROM users WHERE email = $1', [email]);
    if ((userRes.rowCount ?? 0) === 0) return res.status(404).json({ error: 'User not found' });
    const u = userRes.rows[0];
    const rolesRes = await pool.query(
      `SELECT r.id, r.name, r.color, r.position FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.position DESC`,
      [u.id]
    );
    return res.json({ user: { id: u.id, publicId: u.public_id, name: u.name, email: u.email, role: u.role, roles: rolesRes.rows } });
  } catch (err) {
    console.error('[me] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
