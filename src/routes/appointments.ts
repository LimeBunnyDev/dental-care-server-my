/**
 * /api/appointments — booking endpoints.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient } from '../db/pool';

const router = Router();

const visitReason = z.enum([
  'checkup', 'cleaning', 'whitening', 'filling',
  'extraction', 'orthodontics', 'emergency', 'other',
]);

const createSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  dentistId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  reason: visitReason,
  notes: z.string().optional(),
  status: z.enum(['upcoming', 'completed', 'cancelled']).default('upcoming'),
  createdAt: z.string().min(1),
});

const patchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  status: z.enum(['upcoming', 'completed', 'cancelled']).optional(),
  notes: z.string().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid appointment', details: parsed.error.flatten() });
  }
  const a = parsed.data;
  try {
    const row = await withClient((c) => c.query(
      `INSERT INTO appointments (id, user_id, dentist_id, date, time, reason, notes, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         date=EXCLUDED.date,
         time=EXCLUDED.time,
         reason=EXCLUDED.reason,
         notes=EXCLUDED.notes,
         status=EXCLUDED.status
       RETURNING *`,
      [a.id, a.userId, a.dentistId, a.date, a.time, a.reason, a.notes ?? null, a.status, a.createdAt]
    ));
    return res.status(201).json(mapAppointment(row.rows[0]));
  } catch (err: any) {
    console.error('[appts.create]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  const userId = req.query.userId as string | undefined;
  const date = req.query.date as string | undefined;
  try {
    const conds: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (userId) { conds.push(`user_id=$${i++}`); vals.push(userId); }
    if (date) { conds.push(`date=$${i++}`); vals.push(date); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await withClient((c) => c.query(
      `SELECT * FROM appointments ${where} ORDER BY date, time`,
      vals
    ));
    return res.json(rows.rows.map(mapAppointment));
  } catch (err) {
    console.error('[appts.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const row = await withClient((c) => c.query('SELECT * FROM appointments WHERE id = $1', [id]));
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(mapAppointment(row.rows[0]));
  } catch (err) {
    console.error('[appts.get]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid patch', details: parsed.error.flatten() });
  }
  const p = parsed.data;
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (p.date !== undefined) { sets.push(`date=$${i++}`); vals.push(p.date); }
  if (p.time !== undefined) { sets.push(`time=$${i++}`); vals.push(p.time); }
  if (p.status !== undefined) { sets.push(`status=$${i++}`); vals.push(p.status); }
  if (p.notes !== undefined) { sets.push(`notes=$${i++}`); vals.push(p.notes); }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  vals.push(id);
  try {
    const row = await withClient((c) =>
      c.query(`UPDATE appointments SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(mapAppointment(row.rows[0]));
  } catch (err) {
    console.error('[appts.patch]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const row = await withClient((c) =>
      c.query(`UPDATE appointments SET status='cancelled' WHERE id=$1 RETURNING *`, [id])
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(mapAppointment(row.rows[0]));
  } catch (err) {
    console.error('[appts.cancel]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

function mapAppointment(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    dentistId: r.dentist_id,
    date: typeof r.date === 'string' ? r.date : r.date.toISOString().slice(0, 10),
    time: r.time,
    reason: r.reason,
    notes: r.notes ?? undefined,
    status: r.status,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  };
}

export default router;
