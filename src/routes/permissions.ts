/**
 * /api/permissions — read-only catalog of every permission.
 *
 * Requires `roles.view` (Super Admin has it).
 */

import { Router, type Request, type Response } from 'express';

import { withClient } from '../db/pool';
import { requireAuth, requirePermission } from '../auth/middleware';

const router = Router();

router.get(
  '/',
  requireAuth,
  requirePermission('roles.view'),
  async (_req: Request, res: Response) => {
    try {
      const rows = await withClient((c) =>
        c.query(
          `SELECT id, key, category, description
           FROM permissions
           ORDER BY category ASC, key ASC`
        )
      );
      return res.json(
        rows.rows.map((r) => ({
          id: r.id,
          key: r.key,
          category: r.category,
          description: r.description,
        }))
      );
    } catch (err) {
      console.error('[permissions.list]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }
);

export default router;