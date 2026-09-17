/**
 * /api/roles — CRUD for roles and their permission sets.
 *
 * Read access:  roles.view
 * Write access: roles.create, roles.delete, roles.edit_permissions
 * System roles (is_system = true) cannot be deleted.
 * Only Super Admin can touch a role whose tier >= their own maxTier,
 * OR any system role at all.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient, withTransaction } from '../db/pool';
import { requireAuth, requirePermission } from '../auth/middleware';
import { canManageRole } from '../lib/permissions';
import { newRoleId } from '../lib/ids';

const router = Router();

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const createRoleSchema = z.object({
  key:         z.string().min(2).max(40).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits, underscores'),
  name:        z.string().min(2).max(80),
  tier:        z.number().int().min(0).max(999),
  description: z.string().max(300).optional(),
});

const patchRoleSchema = z.object({
  name:        z.string().min(2).max(80).optional(),
  tier:        z.number().int().min(0).max(999).optional(),
  description: z.string().max(300).optional(),
});

const setPermissionsSchema = z.object({
  permissionIds: z.array(z.string().min(1)).max(500),
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function shapeRole(r: any, permissionIds: string[] = []) {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    tier: r.tier,
    is_system: r.is_system,
    description: r.description,
    created_at: r.created_at,
    updated_at: r.updated_at,
    permissionIds,
  };
}

async function loadPermissionsForRole(roleId: string): Promise<string[]> {
  const res = await withClient((c) =>
    c.query<{ permission_id: string }>(
      'SELECT permission_id FROM role_permissions WHERE role_id = $1',
      [roleId]
    )
  );
  return res.rows.map((r) => r.permission_id);
}

// ------------------------------------------------------------
// GET /api/roles — list all roles with their permission ids
// ------------------------------------------------------------

router.get(
  '/',
  requireAuth,
  requirePermission('roles.view'),
  async (_req: Request, res: Response) => {
    try {
      const rows = await withClient((c) =>
        c.query('SELECT * FROM roles ORDER BY tier ASC, name ASC')
      );
      const permRows = await withClient((c) =>
        c.query<{ role_id: string; permission_id: string }>(
          'SELECT role_id, permission_id FROM role_permissions'
        )
      );
      const byRole = new Map<string, string[]>();
      for (const p of permRows.rows) {
        const arr = byRole.get(p.role_id) ?? [];
        arr.push(p.permission_id);
        byRole.set(p.role_id, arr);
      }
      return res.json(rows.rows.map((r) => shapeRole(r, byRole.get(r.id) ?? [])));
    } catch (err) {
      console.error('[roles.list]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// GET /api/roles/:id
// ------------------------------------------------------------

router.get(
  '/:id',
  requireAuth,
  requirePermission('roles.view'),
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    try {
      const row = await withClient((c) =>
        c.query('SELECT * FROM roles WHERE id = $1', [id])
      );
      if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      const permIds = await loadPermissionsForRole(id);
      return res.json(shapeRole(row.rows[0], permIds));
    } catch (err) {
      console.error('[roles.get]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// POST /api/roles — create a role
// ------------------------------------------------------------

router.post(
  '/',
  requireAuth,
  requirePermission('roles.create'),
  async (req: Request, res: Response) => {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { key, name, tier, description } = parsed.data;

    // Tier check: cannot create a role at or above your own maxTier
    // (unless Super Admin).
    const actor = req.auth!.snapshot;
    if (!actor.isSuperAdmin && tier >= actor.maxTier) {
      return res.status(403).json({
        error: `Cannot create a role at tier ${tier} (your max tier is ${actor.maxTier})`,
      });
    }

    try {
      const row = await withTransaction((c) =>
        c.query(
          `INSERT INTO roles (id, key, name, tier, is_system, description)
           VALUES ($1, $2, $3, $4, false, $5)
           RETURNING *`,
          [newRoleId(), key, name, tier, description ?? null]
        )
      );
      return res.status(201).json(shapeRole(row.rows[0], []));
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'A role with that key already exists' });
      }
      console.error('[roles.create]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// PATCH /api/roles/:id
// ------------------------------------------------------------

router.patch(
  '/:id',
  requireAuth,
  requirePermission('roles.view'),   // read-only permission is enough for a GET; PATCH needs manage
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const actor = req.auth!.snapshot;

    const targetRes = await withClient((c) =>
      c.query<{ tier: number; is_system: boolean }>(
        'SELECT tier, is_system FROM roles WHERE id = $1',
        [id]
      )
    );
    if (targetRes.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const target = targetRes.rows[0];

    if (!canManageRole(actor, target.tier, target.is_system)) {
      return res.status(403).json({ error: 'Cannot manage this role' });
    }

    const parsed = patchRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const p = parsed.data;

    // If changing tier, enforce the same ceiling as creation.
    if (p.tier !== undefined && !actor.isSuperAdmin && p.tier >= actor.maxTier) {
      return res.status(403).json({
        error: `Cannot set tier to ${p.tier} (your max tier is ${actor.maxTier})`,
      });
    }

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (p.name        !== undefined) { sets.push(`name=$${i++}`);        vals.push(p.name); }
    if (p.tier        !== undefined) { sets.push(`tier=$${i++}`);        vals.push(p.tier); }
    if (p.description !== undefined) { sets.push(`description=$${i++}`); vals.push(p.description); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(id);

    try {
      const row = await withClient((c) =>
        c.query(`UPDATE roles SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
      );
      const permIds = await loadPermissionsForRole(id);
      return res.json(shapeRole(row.rows[0], permIds));
    } catch (err) {
      console.error('[roles.patch]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// DELETE /api/roles/:id
// ------------------------------------------------------------

router.delete(
  '/:id',
  requireAuth,
  requirePermission('roles.delete'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const actor = req.auth!.snapshot;

    const targetRes = await withClient((c) =>
      c.query<{ tier: number; is_system: boolean; key: string }>(
        'SELECT tier, is_system, key FROM roles WHERE id = $1',
        [id]
      )
    );
    if (targetRes.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const target = targetRes.rows[0];

    if (target.is_system) {
      return res.status(403).json({ error: 'System roles cannot be deleted' });
    }
    if (!canManageRole(actor, target.tier, target.is_system)) {
      return res.status(403).json({ error: 'Cannot delete this role' });
    }

    try {
      await withClient((c) => c.query('DELETE FROM roles WHERE id = $1', [id]));
      return res.status(204).end();
    } catch (err) {
      console.error('[roles.delete]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// PUT /api/roles/:id/permissions — replace a role's permission set
// ------------------------------------------------------------

router.put(
  '/:id/permissions',
  requireAuth,
  requirePermission('roles.edit_permissions'),
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const actor = req.auth!.snapshot;

    const targetRes = await withClient((c) =>
      c.query<{ tier: number; is_system: boolean }>(
        'SELECT tier, is_system FROM roles WHERE id = $1',
        [id]
      )
    );
    if (targetRes.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const target = targetRes.rows[0];

    if (!canManageRole(actor, target.tier, target.is_system)) {
      return res.status(403).json({ error: 'Cannot edit permissions on this role' });
    }

    const parsed = setPermissionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const ids = Array.from(new Set(parsed.data.permissionIds)); // dedupe

    try {
      await withTransaction(async (c) => {
        // Validate all ids exist.
        if (ids.length > 0) {
          const check = await c.query<{ id: string }>(
            'SELECT id FROM permissions WHERE id = ANY($1::text[])',
            [ids]
          );
          const found = new Set(check.rows.map((r) => r.id));
          const missing = ids.filter((x) => !found.has(x));
          if (missing.length > 0) {
            throw Object.assign(new Error('Unknown permission ids'), { code: 'UNKNOWN_PERMS', missing });
          }
        }

        await c.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
        if (ids.length > 0) {
          // Bulk insert.
          const values = ids.map((_, idx) => `($1, $${idx + 2})`).join(', ');
          await c.query(
            `INSERT INTO role_permissions (role_id, permission_id) VALUES ${values}`,
            [id, ...ids]
          );
        }
      });

      const permIds = await loadPermissionsForRole(id);
      return res.json({ roleId: id, permissionIds: permIds });
    } catch (err: any) {
      if (err?.code === 'UNKNOWN_PERMS') {
        return res.status(400).json({ error: 'Unknown permission ids', missing: err.missing });
      }
      console.error('[roles.setPermissions]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

export default router;