/**
 * /api/users/:userId/roles — assign or revoke roles on a user.
 *
 * Gated by user_roles.assign.<roleKey> permissions + a tier check:
 *   actor.maxTier > target.tier (or actor is Super Admin).
 *
 * The tier check is enforced in code (not just in the permission grant),
 * so even if someone is granted `user_roles.assign.admin`, they still need
 * to be strictly above Admin's tier to use it. Defense in depth.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient, withTransaction } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canAssignTier } from '../lib/permissions';

const router = Router({ mergeParams: true });

const assignSchema = z.object({
  roleId: z.string().min(1),
});

// ------------------------------------------------------------
// Helper: resolve user + role, enforce both gates.
// ------------------------------------------------------------

interface EnforceResult {
  ok: true;
  userId: string;
  roleId: string;
  roleKey: string;
  roleTier: number;
}
interface EnforceError {
  ok: false;
  status: number;
  error: string;
}

async function enforceAssign(
  actorUserId: string,
  targetUserId: string,
  roleId: string,
  actorSnapshot: any
): Promise<EnforceResult | EnforceError> {
  if (targetUserId === actorUserId) {
    return { ok: false, status: 400, error: 'You cannot assign roles to yourself' };
  }

  const roleRes = await withClient((c) =>
    c.query<{ id: string; key: string; tier: number }>(
      'SELECT id, key, tier FROM roles WHERE id = $1',
      [roleId]
    )
  );
  if (roleRes.rowCount === 0) {
    return { ok: false, status: 404, error: 'Role not found' };
  }
  const role = roleRes.rows[0];

  // Permission gate: must hold user_roles.assign.<roleKey>.
  const permKey = `user_roles.assign.${role.key}`;
  if (!actorSnapshot.isSuperAdmin && !actorSnapshot.permissions.has(permKey)) {
    return { ok: false, status: 403, error: `Missing permission: ${permKey}` };
  }

  // Tier gate.
  if (!canAssignTier(actorSnapshot, role.tier)) {
    return { ok: false, status: 403, error: 'Your tier is not high enough to assign this role' };
  }

  // Target user must exist.
  const userRes = await withClient((c) =>
    c.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [targetUserId])
  );
  if (userRes.rowCount === 0) {
    return { ok: false, status: 404, error: 'User not found' };
  }

  return { ok: true, userId: targetUserId, roleId: role.id, roleKey: role.key, roleTier: role.tier };
}

// ------------------------------------------------------------
// GET /api/users/:userId/roles — list roles assigned to a user
// ------------------------------------------------------------

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response) => {
    const { userId } = req.params as { userId: string };
    const actor = req.auth!.snapshot;

    // Self, or has users.view.all.
    const self = actor.userId === userId;
    if (!self && !actor.permissions.has('users.view.all')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const rows = await withClient((c) =>
        c.query(
          `SELECT r.id, r.key, r.name, r.tier, r.is_system,
                  ur.granted_by, ur.granted_at
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = $1
           ORDER BY r.tier ASC`,
          [userId]
        )
      );
      return res.json(rows.rows);
    } catch (err) {
      console.error('[user-roles.list]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// POST /api/users/:userId/roles — grant a role
// ------------------------------------------------------------

router.post(
  '/',
  requireAuth,
  async (req: Request, res: Response) => {
    const { userId } = req.params as { userId: string };
    const actor = req.auth!;

    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const gate = await enforceAssign(actor.userId, userId, parsed.data.roleId, actor.snapshot);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    try {
      await withTransaction((c) =>
        c.query(
          `INSERT INTO user_roles (user_id, role_id, granted_by)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [userId, gate.roleId, actor.userId]
        )
      );
      return res.status(201).json({ ok: true, userId, roleId: gate.roleId });
    } catch (err) {
      console.error('[user-roles.assign]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ------------------------------------------------------------
// DELETE /api/users/:userId/roles/:roleId — revoke a role
// ------------------------------------------------------------

router.delete(
  '/:roleId',
  requireAuth,
  async (req: Request, res: Response) => {
    const { userId, roleId } = req.params as { userId: string; roleId: string };
    const actor = req.auth!;

    const gate = await enforceAssign(actor.userId, userId, roleId, actor.snapshot);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    // Safety: the Visitor role is the baseline. Removing it from a non-
    // Super-Admin user would leave them without `profile.*` permissions.
    // Block it to keep the invariant "every user has at least Visitor".
    if (gate.roleKey === 'visitor') {
      return res.status(400).json({ error: 'Cannot revoke the Visitor role' });
    }

    try {
      const del = await withClient((c) =>
        c.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])
      );
      if (del.rowCount === 0) {
        return res.status(404).json({ error: 'User does not have that role' });
      }
      return res.status(204).end();
    } catch (err) {
      console.error('[user-roles.revoke]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

export default router;