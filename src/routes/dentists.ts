/**
 * /api/dentists — public roster of users who hold the Dentist role.
 *
 * Returns profile metadata for dentists. Fields with no value fall back to
 * sensible defaults derived from the username, so the UI always renders.
 */

import { Router, type Request, type Response } from 'express';

import { withClient } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { param } from '../lib/http';

const router = Router();

// ------------------------------------------------------------
// Fallback helpers
// ------------------------------------------------------------

const ACCENT_PALETTE = [
  '#0EA5E9', // sky
  '#10B981', // emerald
  '#F59E0B', // amber
  '#A855F7', // purple
  '#EF4444', // red
  '#EC4899', // pink
  '#14B8A6', // teal
  '#6366F1', // indigo
];

/** Deterministic palette pick from a user id. */
function pickAccent(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return ACCENT_PALETTE[Math.abs(hash) % ACCENT_PALETTE.length];
}

/** "alice" → "AL"; "Dr. Sarah Chen" → "SC"; "bob" → "BO". */
function deriveInitials(displayName: string | null, username: string): string {
  const source = (displayName?.trim() || username).trim();
  const words = source.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '??';
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

function shapeDentist(u: any) {
  const displayName = u.display_name ?? u.username;
  return {
    id:           u.id,
    public_id:    u.public_id,
    username:     u.username,
    display_name: displayName,
    name:         displayName,                         // alias for the UI's `d.name`
    title:        u.dentist_title     ?? null,
    specialty:    u.dentist_specialty ?? null,
    bio:          u.dentist_bio       ?? null,
    initials:     u.dentist_initials  ?? deriveInitials(u.display_name, u.username),
    accentColor:  u.dentist_accent    ?? pickAccent(u.id),
  };
}

// ------------------------------------------------------------
// GET /api/dentists — list all users with the Dentist role
// ------------------------------------------------------------

router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await withClient((c) =>
      c.query(
        `SELECT DISTINCT
           u.id, u.public_id, u.username, u.display_name,
           u.dentist_title, u.dentist_specialty, u.dentist_bio,
           u.dentist_initials, u.dentist_accent
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
        `SELECT DISTINCT
           u.id, u.public_id, u.username, u.display_name,
           u.dentist_title, u.dentist_specialty, u.dentist_bio,
           u.dentist_initials, u.dentist_accent
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