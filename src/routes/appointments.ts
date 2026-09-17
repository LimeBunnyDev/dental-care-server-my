/**
 * /api/appointments — booking, listing, rescheduling, cancelling.
 *
 * Permissions:
 *   appointments.book               → POST /             (create for self)
 *   appointments.view.own           → GET /mine
 *   appointments.view.assigned      → GET /assigned      (dentist's own schedule)
 *   appointments.view.all           → GET /              (all, filterable)
 *   appointments.cancel.self        → DELETE /:id        (own appointment)
 *   appointments.cancel.any         → DELETE /:id        (any appointment)
 *   appointments.reschedule.self    → PATCH /:id         (date/time, own)
 *   appointments.reschedule.any     → PATCH /:id         (date/time, any)
 *   appointments.complete           → PATCH /:id         (status → completed)
 *   appointments.no_show            → PATCH /:id         (status → no_show)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient, withTransaction } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { param, query } from '../lib/http';
import { newAppointmentId } from '../lib/ids';

const router = Router();

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const visitReasonEnum = z.enum([
  'checkup', 'cleaning', 'whitening', 'filling',
  'extraction', 'orthodontics', 'emergency', 'other',
]);

const createSchema = z.object({
  dentistId: z.string().min(1),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:      z.string().regex(/^\d{2}:\d{2}$/),
  reason:    visitReasonEnum,
  notes:     z.string().max(1000).optional(),
});

const patchSchema = z.object({
  date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time:   z.string().regex(/^\d{2}:\d{2}$/).optional(),
  status: z.enum(['upcoming', 'completed', 'cancelled', 'no_show']).optional(),
  notes:  z.string().max(1000).optional(),
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function shapeAppointment(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    dentistId: r.dentist_id,
    date: typeof r.date === 'string' ? r.date : r.date.toISOString().slice(0, 10),
    time: r.time,
    reason: r.reason,
    notes: r.notes ?? undefined,
    status: r.status,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isPastDate(date: string): boolean {
  return date < todayISO();
}

// ------------------------------------------------------------
// POST /api/appointments — book (self)
// ------------------------------------------------------------

router.post('/', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  if (!snap.isSuperAdmin && !snap.permissions.has('appointments.book')) {
    return res.status(403).json({ error: 'Missing permission: appointments.book' });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const { dentistId, date, time, reason, notes } = parsed.data;

  if (isPastDate(date)) {
    return res.status(400).json({ error: 'Cannot book an appointment in the past' });
  }

  try {
    const result = await withTransaction(async (c) => {
      // Dentist must exist and hold the Dentist role.
      const dentist = await c.query(
        `SELECT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r       ON r.id = ur.role_id
         WHERE r.key = 'dentist' AND u.id = $1
         LIMIT 1`,
        [dentistId]
      );
      if (dentist.rowCount === 0) {
        return { kind: 'no_dentist' as const };
      }

      // Slot must be available (override says available, or default-generated available).
      const override = await c.query<{ available: boolean }>(
        `SELECT available FROM availability_slots
         WHERE dentist_id = $1 AND date = $2 AND time = $3`,
        [dentistId, date, time]
      );

      const availableByOverride = override.rowCount === 0
        ? null
        : override.rows[0].available;

      // Also consider already-booked upcoming appointments (partial unique index
      // will enforce this anyway — this is for a friendlier error).
      const conflict = await c.query(
        `SELECT id FROM appointments
         WHERE dentist_id = $1 AND date = $2 AND time = $3 AND status = 'upcoming'
         LIMIT 1`,
        [dentistId, date, time]
      );
      if ((conflict.rowCount ?? 0) > 0) {
        return { kind: 'slot_taken' as const };
      }

      if (availableByOverride === false) {
        return { kind: 'slot_blocked' as const };
      }

      const id = newAppointmentId();
      const inserted = await c.query(
        `INSERT INTO appointments
           (id, user_id, dentist_id, date, time, reason, notes, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'upcoming', $2)
         RETURNING *`,
        [id, req.auth!.userId, dentistId, date, time, reason, notes ?? null]
      );
      return { kind: 'ok' as const, row: inserted.rows[0] };
    });

    switch (result.kind) {
      case 'no_dentist':   return res.status(404).json({ error: 'Dentist not found' });
      case 'slot_taken':   return res.status(409).json({ error: 'Slot is already booked' });
      case 'slot_blocked': return res.status(409).json({ error: 'Slot is not available' });
      case 'ok':           return res.status(201).json(shapeAppointment(result.row));
    }
  } catch (err: any) {
    if (err?.code === '23505') {
      // Unique index race — another request grabbed the slot first.
      return res.status(409).json({ error: 'Slot is already booked' });
    }
    console.error('[appointments.create]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// GET /api/appointments/mine — own appointments
// ------------------------------------------------------------

router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  if (!snap.isSuperAdmin && !snap.permissions.has('appointments.view.own')) {
    return res.status(403).json({ error: 'Missing permission: appointments.view.own' });
  }
  try {
    const rows = await withClient((c) =>
      c.query(
        `SELECT * FROM appointments WHERE user_id = $1
         ORDER BY date DESC, time DESC LIMIT 200`,
        [req.auth!.userId]
      )
    );
    return res.json(rows.rows.map(shapeAppointment));
  } catch (err) {
    console.error('[appointments.mine]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// GET /api/appointments/assigned — dentist's own schedule
// ------------------------------------------------------------

router.get('/assigned', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  if (!snap.isSuperAdmin && !snap.permissions.has('appointments.view.assigned')) {
    return res.status(403).json({ error: 'Missing permission: appointments.view.assigned' });
  }
  const date = query(req, 'date');
  try {
    const conds = ['dentist_id = $1'];
    const vals: any[] = [req.auth!.userId];
    if (date) {
      conds.push(`date = $2`);
      vals.push(date);
    }
    const rows = await withClient((c) =>
      c.query(
        `SELECT * FROM appointments
         WHERE ${conds.join(' AND ')}
         ORDER BY date ASC, time ASC LIMIT 500`,
        vals
      )
    );
    return res.json(rows.rows.map(shapeAppointment));
  } catch (err) {
    console.error('[appointments.assigned]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// GET /api/appointments — all (admin)
// Query params: ?date=YYYY-MM-DD  ?dentistId=  ?userId=  ?status=
// ------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  if (!snap.isSuperAdmin && !snap.permissions.has('appointments.view.all')) {
    return res.status(403).json({ error: 'Missing permission: appointments.view.all' });
  }
  const date      = query(req, 'date');
  const dentistId = query(req, 'dentistId');
  const userId    = query(req, 'userId');
  const status    = query(req, 'status');

  const conds: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (date)      { conds.push(`date = $${i++}`);       vals.push(date); }
  if (dentistId) { conds.push(`dentist_id = $${i++}`); vals.push(dentistId); }
  if (userId)    { conds.push(`user_id = $${i++}`);    vals.push(userId); }
  if (status)    { conds.push(`status = $${i++}`);     vals.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const rows = await withClient((c) =>
      c.query(
        `SELECT * FROM appointments ${where}
         ORDER BY date ASC, time ASC LIMIT 1000`,
        vals
      )
    );
    return res.json(rows.rows.map(shapeAppointment));
  } catch (err) {
    console.error('[appointments.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// GET /api/appointments/:id
// ------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const snap = req.auth!.snapshot;
  try {
    const row = await withClient((c) =>
      c.query('SELECT * FROM appointments WHERE id = $1', [id])
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const a = row.rows[0];

    const isOwner = a.user_id === req.auth!.userId;
    const isDentist = a.dentist_id === req.auth!.userId;
    const canAll = snap.isSuperAdmin || snap.permissions.has('appointments.view.all');

    if (!isOwner && !isDentist && !canAll) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json(shapeAppointment(a));
  } catch (err) {
    console.error('[appointments.get]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// PATCH /api/appointments/:id — reschedule and/or change status
// ------------------------------------------------------------

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const snap = req.auth!.snapshot;

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const p = parsed.data;

  try {
    const found = await withClient((c) =>
      c.query('SELECT * FROM appointments WHERE id = $1', [id])
    );
    if (found.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const a = found.rows[0];

    const isOwner = a.user_id === req.auth!.userId;
    const canReschedule =
      snap.isSuperAdmin ||
      snap.permissions.has('appointments.reschedule.any') ||
      (isOwner && snap.permissions.has('appointments.reschedule.self'));
    const canComplete = snap.isSuperAdmin || snap.permissions.has('appointments.complete');
    const canNoShow   = snap.isSuperAdmin || snap.permissions.has('appointments.no_show');
    const canCancel   =
      snap.isSuperAdmin ||
      snap.permissions.has('appointments.cancel.any') ||
      (isOwner && snap.permissions.has('appointments.cancel.self'));

    // Reschedule: only via date/time changes.
    const isReschedule = p.date !== undefined || p.time !== undefined;
    if (isReschedule && !canReschedule) {
      return res.status(403).json({ error: 'Missing permission to reschedule' });
    }
    if (isReschedule) {
      const newDate = p.date ?? (typeof a.date === 'string' ? a.date : a.date.toISOString().slice(0, 10));
      if (isPastDate(newDate)) {
        return res.status(400).json({ error: 'Cannot reschedule to a past date' });
      }
    }

    // Status transitions.
    if (p.status !== undefined) {
      if (p.status === 'completed' && !canComplete) {
        return res.status(403).json({ error: 'Missing permission: appointments.complete' });
      }
      if (p.status === 'no_show' && !canNoShow) {
        return res.status(403).json({ error: 'Missing permission: appointments.no_show' });
      }
      if (p.status === 'cancelled' && !canCancel) {
        return res.status(403).json({ error: 'Missing permission: appointments.cancel.*' });
      }
    }

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (p.date   !== undefined) { sets.push(`date=$${i++}`);   vals.push(p.date); }
    if (p.time   !== undefined) { sets.push(`time=$${i++}`);   vals.push(p.time); }
    if (p.status !== undefined) { sets.push(`status=$${i++}`); vals.push(p.status); }
    if (p.notes  !== undefined) { sets.push(`notes=$${i++}`);  vals.push(p.notes); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(id);

    const row = await withTransaction((c) =>
      c.query(`UPDATE appointments SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
    );
    return res.json(shapeAppointment(row.rows[0]));
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Slot is already booked' });
    }
    console.error('[appointments.patch]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// DELETE /api/appointments/:id — cancel (soft delete → status='cancelled')
// ------------------------------------------------------------

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const snap = req.auth!.snapshot;

  try {
    const found = await withClient((c) =>
      c.query('SELECT * FROM appointments WHERE id = $1', [id])
    );
    if (found.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const a = found.rows[0];

    const isOwner = a.user_id === req.auth!.userId;
    const canCancel =
      snap.isSuperAdmin ||
      snap.permissions.has('appointments.cancel.any') ||
      (isOwner && snap.permissions.has('appointments.cancel.self'));

    if (!canCancel) return res.status(403).json({ error: 'Missing permission to cancel' });
    if (a.status !== 'upcoming') {
      return res.status(400).json({ error: 'Only upcoming appointments can be cancelled' });
    }

    const row = await withTransaction((c) =>
      c.query(
        `UPDATE appointments SET status = 'cancelled'
         WHERE id = $1 RETURNING *`,
        [id]
      )
    );
    return res.json(shapeAppointment(row.rows[0]));
  } catch (err) {
    console.error('[appointments.cancel]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;