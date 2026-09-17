/**
 * /api/auth — register, login, me.
 *
 * Register is minimal: username, email, password.
 * Everything else (phone, NRIC, address, EC) is set later via PATCH /api/users/me.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withTransaction } from '../db/pool';
import { hashPassword, verifyPassword } from '../auth/password';
import { signToken } from '../auth/jwt';
import { requireAuth } from '../auth/middleware';
import { config } from '../config';
import { newUserId } from '../lib/ids';

const router = Router();

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9._-]+$/i, 'Letters, numbers, dot, underscore, dash only');

const registerSchema = z.object({
  username: usernameSchema,
  email:    z.string().email().max(200),
  password: z.string().min(8).max(100),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const publicUser = (u: {
  id: string; public_id: string; username: string;
  display_name: string | null; email: string;
  is_super_admin: boolean;
}) => ({
  id: u.id,
  public_id: u.public_id,
  username: u.username,
  display_name: u.display_name,
  email: u.email,
  is_super_admin: u.is_super_admin,
});

// ------------------------------------------------------------
// POST /api/auth/register
// ------------------------------------------------------------

router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const username = parsed.data.username.toLowerCase();
  const email    = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  try {
    const result = await withTransaction(async (c) => {
      // Uniqueness check (case-insensitive via lower() index).
      const dupe = await c.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = $1 OR lower(email) = $2 LIMIT 1`,
        [username, email]
      );
      if ((dupe.rowCount ?? 0) > 0) {
        return { kind: 'conflict' as const };
      }

      const passwordHash = await hashPassword(password);
      const id = newUserId();

      // is_super_admin is granted below if this user matches SUPER_ADMIN_USERNAME.
      const isSuperAdmin =
        config.superAdminUsername.length > 0 &&
        username === config.superAdminUsername;

      const inserted = await c.query<{
        id: string; public_id: string; username: string;
        display_name: string | null; email: string; is_super_admin: boolean;
      }>(
        `INSERT INTO users (id, username, email, password_hash, is_super_admin)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, public_id, username, display_name, email, is_super_admin`,
        [id, username, email, passwordHash, isSuperAdmin]
      );

      // Assign the Visitor role by default.
      await c.query(
        `INSERT INTO user_roles (user_id, role_id, granted_by)
         VALUES ($1, 'role_visitor', NULL)
         ON CONFLICT DO NOTHING`,
        [id]
      );

      // If this account is the Super Admin, also give them the Super Admin role.
      if (isSuperAdmin) {
        await c.query(
          `INSERT INTO user_roles (user_id, role_id, granted_by)
           VALUES ($1, 'role_super_admin', NULL)
           ON CONFLICT DO NOTHING`,
          [id]
        );
      }

      return { kind: 'ok' as const, user: inserted.rows[0] };
    });

    if (result.kind === 'conflict') {
      return res.status(409).json({ error: 'Username or email already in use' });
    }

    const u = result.user;
    const token = signToken({ sub: u.id, username: u.username, email: u.email });
    return res.status(201).json({ token, user: publicUser(u) });
  } catch (err) {
    console.error('[auth.register]', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/login
// ------------------------------------------------------------

router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  try {
    const found = await withTransaction((c) =>
      c.query<{
        id: string; public_id: string; username: string;
        display_name: string | null; email: string;
        password_hash: string; is_super_admin: boolean;
      }>(
        `SELECT id, public_id, username, display_name, email,
                password_hash, is_super_admin
         FROM users WHERE lower(email) = $1`,
        [email]
      )
    );

    const user = found.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Self-healing Super Admin grant: if the env var matches and the flag
    // isn't set yet (e.g. you changed SUPER_ADMIN_USERNAME after registering),
    // apply it on login.
    let isSuperAdmin = user.is_super_admin;
    if (!isSuperAdmin && config.superAdminUsername && user.username === config.superAdminUsername) {
      await withTransaction(async (c) => {
        await c.query('UPDATE users SET is_super_admin = true WHERE id = $1', [user.id]);
        await c.query(
          `INSERT INTO user_roles (user_id, role_id, granted_by)
           VALUES ($1, 'role_super_admin', NULL)
           ON CONFLICT DO NOTHING`,
          [user.id]
        );
      });
      isSuperAdmin = true;
    }

    const token = signToken({ sub: user.id, username: user.username, email: user.email });
    return res.json({
      token,
      user: publicUser({ ...user, is_super_admin: isSuperAdmin }),
    });
  } catch (err) {
    console.error('[auth.login]', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ------------------------------------------------------------
// GET /api/auth/me — current user + their permissions
// ------------------------------------------------------------

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const found = await withTransaction((c) =>
      c.query(
        `SELECT id, public_id, username, display_name, email,
                phone, nric, birthday,
                address_line1, address_line2, city, postcode, state,
                ec_name, ec_phone, ec_relationship,
                is_super_admin, created_at
         FROM users WHERE id = $1`,
        [req.auth!.userId]
      )
    );
    const u = found.rows[0];
    if (!u) return res.status(404).json({ error: 'Not found' });

    const snap = req.auth!.snapshot;
    return res.json({
      user: {
        id: u.id,
        public_id: u.public_id,
        username: u.username,
        display_name: u.display_name,
        email: u.email,
        phone: u.phone,
        nric: u.nric,
        birthday: u.birthday,
        address: {
          line1: u.address_line1,
          line2: u.address_line2,
          city: u.city,
          postcode: u.postcode,
          state: u.state,
        },
        emergencyContact: {
          name: u.ec_name,
          phone: u.ec_phone,
          relationship: u.ec_relationship,
        },
        is_super_admin: u.is_super_admin,
        created_at: u.created_at,
      },
      roles: snap.roleKeys,
      permissions: Array.from(snap.permissions).sort(),
      maxTier: snap.maxTier,
    });
  } catch (err) {
    console.error('[auth.me]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;