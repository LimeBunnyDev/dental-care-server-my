/**
 * Permission resolution. Given a user id, returns:
 *   - effective permission keys (union across all roles)
 *   - max tier (for hierarchy checks)
 *   - is_super_admin flag
 *
 * The result is memoized per-request only (see middleware) — never cached
 * across requests, because role/permission changes must take effect immediately.
 */

import { withClient } from '../db/pool';

export interface PermissionSnapshot {
  userId: string;
  isSuperAdmin: boolean;
  maxTier: number;
  permissions: Set<string>;
  roleIds: string[];
  roleKeys: string[];
}

export async function loadPermissions(userId: string): Promise<PermissionSnapshot | null> {
  return withClient(async (c) => {
    const userRes = await c.query<{ is_super_admin: boolean }>(
      'SELECT is_super_admin FROM users WHERE id = $1',
      [userId]
    );
    if (userRes.rowCount === 0) return null;

    const isSuperAdmin = userRes.rows[0].is_super_admin === true;

    const rolesRes = await c.query<{ id: string; key: string; tier: number }>(
      `SELECT r.id, r.key, r.tier
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId]
    );

    const roleIds   = rolesRes.rows.map((r) => r.id);
    const roleKeys  = rolesRes.rows.map((r) => r.key);
    const maxTier   = rolesRes.rows.reduce((m, r) => Math.max(m, r.tier), 0);

    let permissions = new Set<string>();

    if (roleIds.length > 0) {
      const permRes = await c.query<{ key: string }>(
        `SELECT DISTINCT p.key
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ANY($1::text[])`,
        [roleIds]
      );
      permissions = new Set(permRes.rows.map((r) => r.key));
    }

    // Super Admin implicitly has every permission, even ones added later.
    if (isSuperAdmin) {
      const allRes = await c.query<{ key: string }>('SELECT key FROM permissions');
      for (const r of allRes.rows) permissions.add(r.key);
    }

    return { userId, isSuperAdmin, maxTier, permissions, roleIds, roleKeys };
  });
}

/**
 * Hierarchy check. Can `actor` assign a role at `targetTier`?
 * Rule: actor must be a strictly higher tier, OR be Super Admin.
 * (Equal tier cannot assign — this prevents peers from promoting each other.)
 */
export function canAssignTier(actor: PermissionSnapshot, targetTier: number): boolean {
  if (actor.isSuperAdmin) return true;
  return actor.maxTier > targetTier;
}

/**
 * Can `actor` manage (edit/delete) a role? Requires Super Admin for
 * system roles, otherwise strictly higher tier than the target.
 */
export function canManageRole(actor: PermissionSnapshot, targetTier: number, isSystem: boolean): boolean {
  if (actor.isSuperAdmin) return true;
  if (isSystem) return false;                 // only Super Admin touches system roles
  return actor.maxTier > targetTier;
}