// src/routes/auth.ts
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db';

const authRouter: Router = Router();

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  password: z.string().min(6).max(200),
  phone: z.string().max(30).optional(),
  nric: z.string().max(20).optional(),
  birthday: z.string().max(10).optional(), // YYYY-MM-DD, plain profile field
  address: z.string().max(300).optional(),
  addressLat: z.number().optional(),
  addressLon: z.number().optional(),
  ecName: z.string().max(120).optional(),
  ecPhone: z.string().max(30).optional(),
});

// POST /api/auth/register — everyone registers role-less.
// Mints a plain sequential 8-digit public_id (00000001, 00000002, ...).
authRouter.post('/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const d = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // duplicate email check
      const dup = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [d.email.toLowerCase()]);
      if ((dup.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already registered' });
      }

      // next global 8-digit id
      const seq = await client.query(`SELECT LPAD(nextval('public_id_seq')::text, 8, '0') AS public_id`);
      const publicId: string = seq.rows[0].public_id;

      const passwordHash = await bcrypt.hash(d.password, 10);
      const internalId = 'u_' + publicId; // internal id, stable & unique

      const insert = await client.query(
        `INSERT INTO users
           (id, name, email, password_hash, phone, nric, birthday,
            address_line1, address_lat, address_lon,
            ec_name, ec_phone, public_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, public_id, email, name`,
        [
          internalId,
          d.name,
          d.email.toLowerCase(),
          passwordHash,
          d.phone ?? null,
          d.nric ?? null,
          d.birthday ?? null,
          d.address ?? null,
          d.addressLat ?? null,
          d.addressLon ?? null,
          d.ecName ?? null,
          d.ecPhone ?? null,
          publicId,
        ]
      );

      await client.query('COMMIT');
      const u = insert.rows[0];
      return res.status(201).json({
        ok: true,
        user: { id: u.id, public_id: u.public_id, email: u.email, name: u.name },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[register] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/auth/login
authRouter.post('/login', async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    const { email, password } = parsed.data;
    const result = await pool.query(
      `SELECT u.id, u.public_id, u.email, u.name, u.password_hash,
              COALESCE(
                json_agg(r.name) FILTER (WHERE r.id IS NOT NULL), '[]'
              ) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.email = $1
       GROUP BY u.id`,
      [email.toLowerCase()]
    );
    if (result.rowCount === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash ?? '');
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    return res.json({
      ok: true,
      user: { id: user.id, public_id: user.public_id, email: user.email, name: user.name, roles: user.roles },
    });
  } catch (err: any) {
    console.error('[login] error:', err?.message ?? err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default authRouter;
