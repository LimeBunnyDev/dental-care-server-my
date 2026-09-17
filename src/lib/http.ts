/**
 * Small HTTP helpers used across route files.
 */

import type { Request } from 'express';

/**
 * Safe single-value route param accessor.
 * @types/express@5 types req.params values as `string | string[]`,
 * but for our routes (no regex arrays) they're always strings.
 */
export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** Safely read a query string as a single string. */
export function query(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}