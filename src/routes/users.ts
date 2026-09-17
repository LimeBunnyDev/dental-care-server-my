/**
 * /api/users — profile self-service + admin operations.
 *
 * Permission gate: all routes here require auth. Self-actions require
 * profile.*.self permissions; cross-user actions require users.* permissions.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient, withTransaction } from '../db/pool';
import { requireAuth, requirePermission } from '../auth/middleware';
import { hashPassword } from '../auth/password';

const router = Router();

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const addressSchema = z.object({
  line1:    z.string().min(1).max(200),
  line2:    z.string().max(200).optional(),
  city:     z.string().min(1).max(100),
  postcode: z.string().min(1).max(20),
  state:    z.string().min(1).max(100),
});

const emergencyContactSchema = z.object({
  name:         z.string().min(1).max(120),
  phone:        z.string().min(1).max(30),
  relationship: z.string().max(60).optional(),
});

const patchMeSchema = z.object({
  display_name:     z.string().min(1).max(60).optional(),
  phone:            z.string().min(1).max(30).optional(),
  nric:             z.string().min(1).max(20).optional(),
  birthday:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  address:          addressSchema.optional(),
  emergencyContact: emergencyContactSchema.optional(),
  password:         z.string().min(8).max(100).optional(),
});

const adminPatchSchema = patchMeSchema.extend({
  // Admin may also set these.
  username:     z.string().min(3).max(32).optional(),
  email:        z.string().email().optional(),
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function shapeUser(u: any) {
  return {
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
    updated_at: u.updated_at,
  };
}

// ------------------------------------------------------------
// GET /api/users/me
// ------------------------------------------------------------

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await withClient((c) =>
      c.query('SELECT * FROM users WHERE id = $1', [req.auth!.userId])
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(shapeUser(row.rows[0]));
  } catch (err) {
    console.error('[users.me]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// PATCH /api/users/me — self profile update
// ------------------------------------------------------------

router.patch(
  '/me',
  requireAuth,
  requirePermission('profile.edit.self'),
  async (req: Request, res: Response) => {
    const parsed = patchMeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const p = parsed.data;

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (p.display_name !== undefined) { sets.push(`display_name=$${i++}`); vals.push(p.display_name); }
    if (p.phone        !== undefined) { sets.push(`phone=$${i++}`);        vals.push(p.phone); }
    if (p.nric         !== undefined) { sets.push(`nric=$${i++}`);         vals.push(p.nric); }
    if (p.birthday     !== undefined) { sets.push(`birthday=$${i++}`);     vals.push(p.birthday); }

    if (p.address) {
      sets.push(`address_line1=$${i++}`); vals.push(p.address.line1);
      sets.push(`address_line2=$${i++}`); vals.push(p.address.line2 ?? null);
      sets.push(`city=$${i++}`);          vals.push(p.address.city);
      sets.push(`postcode=$${i++}`);      vals.push(p.address.postcode);
      sets.push(`state=$${i++}`);         vals.push(p.address.state);
    }

    if (p.emergencyContact) {
      sets.push(`ec_name=$${i++}`);         vals.push(p.emergencyContact.name);
      sets.push(`ec_phone=$${i++}`);        vals.push(p.emergencyContact.phone);
      sets.push(`ec_relationship=$${i++}`); vals.push(p.emergencyContact.relationship ?? null);
    }

    if (p.password !== undefined) {
      const hash = await hashPassword(p.password);
      sets.push(`password_hash=$${i++}`); vals.push(hash);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.auth!.userId);

    try {
      const row = await withClient((c) =>
        c.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
      );
      return res.json(shapeUser(row.rows[0]));
    } catch (err) {
      console.error('[users.patch.me]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// DELETE /api/users/me — self account deletion
// ------------------------------------------------------------

router.delete(
  '/me',
  requireAuth,
  requirePermission('profile.delete.self'),
  async (req: Request, res: Response) => {
    // Safety: Super Admin cannot self-delete via this route.
    if (req.auth!.snapshot.isSuperAdmin) {
      return res.status(403).json({
        error: 'Super Admin cannot self-delete. Demote via env change first.',
      });
    }
    try {
      await withClient((c) => c.query('DELETE FROM users WHERE id = $1', [req.auth!.userId]));
      return res.status(204).end();
    } catch (err) {
      console.error('[users.delete.me]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// GET /api/users — list all users (admin)
// ------------------------------------------------------------

router.get(
  '/',
  requireAuth,
  requirePermission('users.view.all'),
  async (_req: Request, res: Response) => {
    try {
      const rows = await withClient((c) =>
        c.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 500')
      );
      return res.json(rows.rows.map(shapeUser));
    } catch (err) {
      console.error('[users.list]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// GET /api/users/:id — view one user
// ------------------------------------------------------------

router.get(
  '/:id',
  requireAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const self = req.auth!.userId === id;
    const canViewAll = req.auth!.snapshot.permissions.has('users.view.all');

    if (!self && !canViewAll) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const row = await withClient((c) =>
        c.query('SELECT * FROM users WHERE id = $1', [id])
      );
      if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      return res.json(shapeUser(row.rows[0]));
    } catch (err) {
      console.error('[users.get]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// PATCH /api/users/:id — admin edit
// ------------------------------------------------------------

router.patch(
  '/:id',
  requireAuth,
  requirePermission('users.edit.any'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsed = adminPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const p = parsed.data;

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (p.username     !== undefined) { sets.push(`username=$${i++}`);     vals.push(p.username.toLowerCase()); }
    if (p.email        !== undefined) { sets.push(`email=$${i++}`);        vals.push(p.email.toLowerCase()); }
    if (p.display_name !== undefined) { sets.push(`display_name=$${i++}`); vals.push(p.display_name); }
    if (p.phone        !== undefined) { sets.push(`phone=$${i++}`);        vals.push(p.phone); }
    if (p.nric         !== undefined) { sets.push(`nric=$${i++}`);         vals.push(p.nric); }
    if (p.birthday     !== undefined) { sets.push(`birthday=$${i++}`);     vals.push(p.birthday); }

    if (p.address) {
      sets.push(`address_line1=$${i++}`); vals.push(p.address.line1);
      sets.push(`address_line2=$${i++}`); vals.push(p.address.line2 ?? null);
      sets.push(`city=$${i++}`);          vals.push(p.address.city);
      sets.push(`postcode=$${i++}`);      vals.push(p.address.postcode);
      sets.push(`state=$${i++}`);         vals.push(p.address.state);
    }

    if (p.emergencyContact) {
      sets.push(`ec_name=$${i++}`);         vals.push(p.emergencyContact.name);
      sets.push(`ec_phone=$${i++}`);        vals.push(p.emergencyContact.phone);
      sets.push(`ec_relationship=$${i++}`); vals.push(p.emergencyContact.relationship ?? null);
    }

    if (p.password !== undefined) {
      const hash = await hashPassword(p.password);
      sets.push(`password_hash=$${i++}`); vals.push(hash);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(id);

    try {
      const row = await withTransaction((c) =>
        c.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
      );
      if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      return res.json(shapeUser(row.rows[0]));
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Username or email already in use' });
      }
      console.error('[users.patch.admin]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// DELETE /api/users/:id — admin delete
// ------------------------------------------------------------

router.delete(
  '/:id',
  requireAuth,
  requirePermission('users.delete.any'),
  async (req: Request, res: Response) => {
    const { id } = req.params;

    // Safety: cannot delete the Super Admin.
    const target = await withClient((c) =>
      c.query<{ is_super_admin: boolean }>('SELECT is_super_admin FROM users WHERE id = $1', [id])
    );
    if (target.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    if (target.rows[0].is_super_admin) {
      return res.status(403).json({ error: 'Cannot delete Super Admin' });
    }

    try {
      await withClient((c) => c.query('DELETE FROM users WHERE id = $1', [id]));
      return res.status(204).end();
    } catch (err) {
      console.error('[users.delete.admin]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

export default router;