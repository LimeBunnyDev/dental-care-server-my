/**
 * /api/availability — dentist schedule per date.
 *
 * GET  /api/availability/:dentistId?date=YYYY-MM-DD
 *   Returns the effective slots for that dentist on that date:
 *     - overrides from `availability_slots` if any exist for that date, OR
 *     - a deterministic default (same generator as the old frontend) otherwise.
 *   Merges in `booked: true` for slots that have an upcoming appointment.
 *
 * PUT  /api/availability/:dentistId
 *   Replaces the overrides for a given date with the supplied list.
 *   Requires `availability.edit`.
 *
 * DELETE /api/availability/:dentistId?date=YYYY-MM-DD
 *   Removes all overrides for that date, reverting to the generated default.
 *   Requires `availability.edit`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient, withTransaction } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { param, query } from '../lib/http';

const router = Router();

// ------------------------------------------------------------
// Default slot generator — mirrors the old frontend logic so the
// demo behaves consistently. Deterministic per (dentistId, date).
// ------------------------------------------------------------

const BASE_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
];

function generateDefaultSlots(dentistId: string, date: string): { time: string; available: boolean }[] {
  const seed =
    dentistId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) +
    date.split('-').reduce((acc, n) => acc + Number(n), 0);
  return BASE_TIMES.map((time, i) => {
    const unavailable = (seed + i * 7) % 5 === 0;   // ~20% "busy" by default
    return { time, available: !unavailable };
  });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isTimePassed(date: string, time: string): boolean {
  if (date !== todayISO()) return false;
  const [h, m] = time.split(':').map(Number);
  const now = new Date();
  if (now.getHours() > h) return true;
  if (now.getHours() === h && now.getMinutes() >= m) return true;
  return false;
}

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const putSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slots: z.array(z.object({
    time:      z.string().regex(/^\d{2}:\d{2}$/),
    available: z.boolean(),
  })).max(64),
});

// ------------------------------------------------------------
// GET /api/availability/:dentistId?date=YYYY-MM-DD
// ------------------------------------------------------------

router.get('/:dentistId', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  const dentistId = param(req, 'dentistId');
  const date = query(req, 'date');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Missing or invalid ?date=YYYY-MM-DD' });
  }

  const isSelf = dentistId === req.auth!.userId;
  const canViewAny = snap.isSuperAdmin || snap.permissions.has('availability.view.all');
  const canViewSelf = snap.permissions.has('availability.view.self');
  if (!isSelf && !canViewAny) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (isSelf && !canViewSelf && !canViewAny) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    // 1. Load overrides (if any) for this date.
    const ovr = await withClient((c) =>
      c.query<{ time: string; available: boolean }>(
        `SELECT time, available FROM availability_slots
         WHERE dentist_id = $1 AND date = $2
         ORDER BY time ASC`,
        [dentistId, date]
      )
    );

    // 2. Base set: overrides if present, otherwise generated defaults.
    const base = ovr.rowCount && ovr.rowCount > 0
      ? ovr.rows
      : generateDefaultSlots(dentistId, date);

    // 3. Mark booked slots from upcoming appointments.
    const booked = await withClient((c) =>
      c.query<{ time: string }>(
        `SELECT time FROM appointments
         WHERE dentist_id = $1 AND date = $2 AND status = 'upcoming'`,
        [dentistId, date]
      )
    );
    const bookedSet = new Set(booked.rows.map((r) => r.time));

    // 4. Compose result. Hide past slots for today.
    const slots = base.map((s) => {
      const past = isTimePassed(date, s.time);
      const isBooked = bookedSet.has(s.time);
      return {
        time: s.time,
        available: s.available && !isBooked && !past,
        booked: isBooked,
        past,
      };
    });

    return res.json({
      dentistId,
      date,
      source: ovr.rowCount && ovr.rowCount > 0 ? 'override' : 'default',
      slots,
    });
  } catch (err) {
    console.error('[availability.get]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// PUT /api/availability/:dentistId — replace overrides for a date
// ------------------------------------------------------------

router.put('/:dentistId', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  if (!snap.isSuperAdmin && !snap.permissions.has('availability.edit')) {
    return res.status(403).json({ error: 'Missing permission: availability.edit' });
  }

  const dentistId = param(req, 'dentistId');
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const { date, slots } = parsed.data;

  // Validate the dentist exists and holds the Dentist role.
  const dentistCheck = await withClient((c) =>
    c.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r       ON r.id = ur.role_id
       WHERE r.key = 'dentist' AND u.id = $1 LIMIT 1`,
      [dentistId]
    )
  );
  if (dentistCheck.rowCount === 0) {
    return res.status(404).json({ error: 'Dentist not found' });
  }

  // Deduplicate by time (last write wins).
  const byTime = new Map<string, boolean>();
  for (const s of slots) byTime.set(s.time, s.available);

  try {
    await withTransaction(async (c) => {
      await c.query(
        'DELETE FROM availability_slots WHERE dentist_id = $1 AND date = $2',
        [dentistId, date]
      );

      const entries = Array.from(byTime.entries());
      if (entries.length === 0) return;

      // Bulk insert.
      const values: string[] = [];
      const vals: any[] = [dentistId, date, req.auth!.userId];
      entries.forEach(([time, available], idx) => {
        const tIdx = vals.length + 1;
        const aIdx = vals.length + 2;
        values.push(`($1, $2, $${tIdx}, $${aIdx}, $3)`);
        vals.push(time, available);
      });
      await c.query(
        `INSERT INTO availability_slots
           (dentist_id, date, time, available, updated_by)
         VALUES ${values.join(', ')}`,
        vals
      );
    });

    return res.json({ ok: true, dentistId, date, count: byTime.size });
  } catch (err) {
    console.error('[availability.put]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ------------------------------------------------------------
// DELETE /api/availability/:dentistId?date=YYYY-MM-DD — revert to default
// ------------------------------------------------------------

router.delete('/:dentistId', requireAuth, async (req: Request, res: Response) => {
  const snap = req.auth!.snapshot;
  if (!snap.isSuperAdmin && !snap.permissions.has('availability.edit')) {
    return res.status(403).json({ error: 'Missing permission: availability.edit' });
  }

  const dentistId = param(req, 'dentistId');
  const date = query(req, 'date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Missing or invalid ?date=YYYY-MM-DD' });
  }

  try {
    const del = await withClient((c) =>
      c.query(
        'DELETE FROM availability_slots WHERE dentist_id = $1 AND date = $2',
        [dentistId, date]
      )
    );
    return res.json({ ok: true, dentistId, date, removed: del.rowCount ?? 0 });
  } catch (err) {
    console.error('[availability.delete]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;