import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db';

const router = Router();

// ---------- Validation ----------
const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // "1995-02-10"
  nric: z.string().optional(),
  passwordHash: z.string().min(1),
  addressGeo: z
    .object({ lat: z.number(), lon: z.number() })
    .nullish()
    .optional(),
  // NOTE: no role, no inviteCode — new users are role-less by design.
});

const loginSchema = z.object({
  email: z.string().email(),
  passwordHash: z.string().min(1),
});

// ---------- Helpers ----------
function toPgDate(birthday?: string | null): string | null {
  return birthday && /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday : null;
}

// ---------- POST /api/auth/register ----------
// New users are always role-less. Roles are assigned later by permitted
// admins via the admin panel. Public ID is a global 8-digit counter.
router.post('/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { name, email, phone, birthday, nric, passwordHash, addressGeo } = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Duplicate email check
      const dup = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if ((dup.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already registered' });
      }

      // 2. Mint the next 8-digit public_id atomically
      const seq = await client.query("SELECT nextval('public_id_seq') AS n");
      const nextNum = Number(seq.rows[0].n);
      const publicId = String(nextNum).padStart(8, '0');

      // 3. Insert the user (role-less; roles assigned post-registration)
      const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const result = await client.query(
        `INSERT INTO users
           (id, name, email, phone, birthday, nric, password_hash, public_id, address_lat, address_lon)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, public_id, name, email`,
        [
          id,
          name,
          email,
          phone ?? null,
          toPgDate(birthday),
          nric ?? null,
          passwordHash,
          publicId,
          addressGeo?.lat ?? null,
          addressGeo?.lon ?? null,
        ]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        ok: true,
        user: result.rows[0], // { id, public_id, name, email }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[register] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// ---------- PATCH /api/auth/birthday ----------
// Birthday is now just a normal profile field — changing it does NOT touch
// the public ID. 30-day cooldown kept for data hygiene.
router.patch('/birthday', async (req, res) => {
  try {
    const schema = z.object({
      userId: z.string().min(1),
      birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { userId, birthday } = parsed.data;

    const cur = await pool.query(
      'SELECT birthday, birthday_changed_at FROM users WHERE id = $1',
      [userId]
    );
    if ((cur.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const changedAt = cur.rows[0].birthday_changed_at
      ? new Date(cur.rows[0].birthday_changed_at).getTime()
      : 0;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (changedAt && Date.now() - changedAt < thirtyDays) {
      return res.status(429).json({ error: 'Birthday can only be changed every 30 days' });
    }

    const upd = await pool.query(
      'UPDATE users SET birthday = $1, birthday_changed_at = now() WHERE id = $2 RETURNING id, public_id, birthday',
      [toPgDate(birthday), userId]
    );
    return res.json({ ok: true, user: upd.rows[0] });
  } catch (err: any) {
    console.error('[birthday] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Update failed' });
  }
});

// ---------- POST /api/auth/login ----------
// Returns the user's public_id and their roles + permissions, so the app
// can gate screens by permission instead of a hardcoded role name.
router.post('/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { email, passwordHash } = parsed.data;

    const u = await pool.query(
      `SELECT id, public_id, name, email, phone, birthday
         FROM users WHERE email = $1 AND password_hash = $2`,
      [email, passwordHash]
    );
    if ((u.rowCount ?? 0) === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = u.rows[0];

    // Fetch roles + flattened permissions for this user
    const roles = await pool.query(
      `SELECT r.id, r.name, r.color, r.position,
              COALESCE(array_agg(rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permissions
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = $1
        GROUP BY r.id, r.name, r.color, r.position
        ORDER BY r.position DESC`,
      [user.id]
    );

    const permissionSet = new Set<string>();
    for (const row of roles.rows) {
      for (const p of row.permissions ?? []) permissionSet.add(p);
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        publicId: user.public_id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        birthday: user.birthday,
      },
      roles: roles.rows.map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position })),
      permissions: Array.from(permissionSet),
    });
  } catch (err: any) {
    console.error('[login] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

export default router;
