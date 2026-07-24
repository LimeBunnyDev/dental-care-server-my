/**
 * /api/dentists — read-only roster endpoints.
 */

import { Router, type Request, type Response } from 'express';

import { withClient } from '../db/pool';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await withClient((c) => c.query('SELECT * FROM dentists ORDER BY name'));
    return res.json(rows.rows.map((r: any) => ({
      id: r.id, name: r.name, title: r.title, specialty: r.specialty,
      bio: r.bio, initials: r.initials, accentColor: r.accent_color,
    })));
  } catch (err) {
    console.error('[dentists.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const row = await withClient((c) => c.query('SELECT * FROM dentists WHERE id = $1', [id]));
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const r = row.rows[0];
    return res.json({
      id: r.id, name: r.name, title: r.title, specialty: r.specialty,
      bio: r.bio, initials: r.initials, accentColor: r.accent_color,
    });
  } catch (err) {
    console.error('[dentists.get]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
