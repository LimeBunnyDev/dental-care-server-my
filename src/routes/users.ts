/**
 * /api/users — CRUD endpoints for the user table.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { withClient } from '../db/pool';
import { rowToPublicUser } from '../db/mappers';

const router = Router();

const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  postcode: z.string().min(1),
  state: z.string().min(1),
});

const emergencyContactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  relationship: z.string().optional(),
});

const createUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  nric: z.string().min(1),
  address: addressSchema,
  emergencyContact: emergencyContactSchema,
  passwordHash: z.string().min(1),
  role: z.enum(['patient', 'admin']).default('patient'),
  createdAt: z.string().min(1),
});

const patchUserSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  nric: z.string().min(1).optional(),
  address: addressSchema.optional(),
  emergencyContact: emergencyContactSchema.optional(),
  role: z.enum(['patient', 'admin']).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid user payload', details: parsed.error.flatten() });
  }
  const u = parsed.data;
  try {
    const row = await withClient(async (c) => {
      const result = await c.query(
        `INSERT INTO users (
           id, name, email, phone, nric,
           address_line1, address_line2, city, postcode, state,
           ec_name, ec_phone, ec_relationship,
           password_hash, role, created_at
         ) VALUES (
           $1,$2,$3,$4,$5,
           $6,$7,$8,$9,$10,
           $11,$12,$13,
           $14,$15,$16
         )
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name,
           email=EXCLUDED.email,
           phone=EXCLUDED.phone,
           nric=EXCLUDED.nric,
           address_line1=EXCLUDED.address_line1,
           address_line2=EXCLUDED.address_line2,
           city=EXCLUDED.city,
           postcode=EXCLUDED.postcode,
           state=EXCLUDED.state,
           ec_name=EXCLUDED.ec_name,
           ec_phone=EXCLUDED.ec_phone,
           ec_relationship=EXCLUDED.ec_relationship,
           password_hash=EXCLUDED.password_hash,
           role=EXCLUDED.role
         RETURNING *`,
        [
          u.id, u.name, u.email, u.phone, u.nric,
          u.address.line1, u.address.line2 ?? null, u.address.city, u.address.postcode, u.address.state,
          u.emergencyContact.name, u.emergencyContact.phone, u.emergencyContact.relationship ?? null,
          u.passwordHash, u.role, u.createdAt,
        ]
      );
      return result.rows[0];
    });
    return res.status(201).json(rowToPublicUser(row));
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'A user with that id already exists' });
    }
    console.error('[users.create]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await withClient((c) => c.query('SELECT * FROM users ORDER BY created_at DESC'));
    return res.json(rows.rows.map(rowToPublicUser));
  } catch (err) {
    console.error('[users.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const row = await withClient((c) => c.query('SELECT * FROM users WHERE id = $1', [id]));
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(rowToPublicUser(row.rows[0]));
  } catch (err) {
    console.error('[users.get]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = patchUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid patch', details: parsed.error.flatten() });
  }
  const p = parsed.data;
  if (Object.keys(p).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (p.name !== undefined) { sets.push(`name=$${i++}`); vals.push(p.name); }
  if (p.phone !== undefined) { sets.push(`phone=$${i++}`); vals.push(p.phone); }
  if (p.nric !== undefined) { sets.push(`nric=$${i++}`); vals.push(p.nric); }
  if (p.address !== undefined) {
    sets.push(`address_line1=$${i++}`); vals.push(p.address.line1);
    sets.push(`address_line2=$${i++}`); vals.push(p.address.line2 ?? null);
    sets.push(`city=$${i++}`); vals.push(p.address.city);
    sets.push(`postcode=$${i++}`); vals.push(p.address.postcode);
    sets.push(`state=$${i++}`); vals.push(p.address.state);
  }
  if (p.emergencyContact !== undefined) {
    sets.push(`ec_name=$${i++}`); vals.push(p.emergencyContact.name);
    sets.push(`ec_phone=$${i++}`); vals.push(p.emergencyContact.phone);
    sets.push(`ec_relationship=$${i++}`); vals.push(p.emergencyContact.relationship ?? null);
  }
  if (p.role !== undefined) { sets.push(`role=$${i++}`); vals.push(p.role); }
  vals.push(id);

  try {
    const row = await withClient((c) =>
      c.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(rowToPublicUser(row.rows[0]));
  } catch (err) {
    console.error('[users.patch]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const row = await withClient((c) => c.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]));
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (err) {
    console.error('[users.delete]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
