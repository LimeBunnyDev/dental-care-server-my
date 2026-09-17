/**
 * /api/dentists — public roster of users who hold the Dentist role.
 *
 * Read-only. Anyone authenticated may call this (patients need it to book).
 * Returns only non-sensitive fields.
 */

import { Router, type Request, type Response } from 'express';

import { withClient } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { param } from '../lib/http';

const router = Router();

function shapeDentist(u: any) {
  return {
    id: u.id,
    public_id: u.public_id,
    username: u.username,
    display_name: u.display_name ?? u.username,
  };
}

// ------------------------------------------------------------
// GET /api/dentists — list all users with the Dentist role
// ------------------------------------------------------------

router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await withClient((c) =>
      c.query(
        `SELECT DISTINCT u.id, u.public_id, u.username, u.display_name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r       ON r.id = ur.role_id
         WHERE r.key = 'dentist'
         ORDER BY u.username ASC`
      )
    );
    return res.json(rows.rows.map(shapeDentist));
  } catch (err) {
    console.error('[dentists.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// GET /api/dentists/:id
// ------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = param(req, 'id');
  try {
    const rows = await withClient((c) =>
      c.query(
        `SELECT DISTINCT u.id, u.public_id, u.username, u.display_name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r       ON r.id = ur.role_id
         WHERE r.key = 'dentist' AND u.id = $1
         LIMIT 1`,
        [id]
      )
    );
    if (rows.rowCount === 0) return res.status(404).json({ error: 'Dentist not found' });
    return res.json(shapeDentist(rows.rows[0]));
  } catch (err) {
    console.error('[dentists.get]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;