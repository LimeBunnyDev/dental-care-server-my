/**
 * Express middleware: requireAuth, requirePermission, requireSuperAdmin.
 * Attaches `req.auth` = { userId, snapshot } on success.
 */

import type { NextFunction, Request, Response } from 'express';

import { extractBearer, verifyToken } from './jwt';
import {
  loadPermissions,
  canAssignTier,
  type PermissionSnapshot,
} from '../lib/permissions';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        snapshot: PermissionSnapshot;
      };
    }
  }
}

/** Verifies the JWT, loads fresh permissions, attaches req.auth. 401 otherwise. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearer(req.header('authorization'));
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  const snapshot = await loadPermissions(payload.sub);
  if (!snapshot) return res.status(401).json({ error: 'User no longer exists' });

  req.auth = { userId: payload.sub, snapshot };
  next();
}

/** Optional auth — attaches req.auth if a valid token is present, but never blocks. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractBearer(req.header('authorization'));
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const snapshot = await loadPermissions(payload.sub);
      if (snapshot) req.auth = { userId: payload.sub, snapshot };
    }
  }
  next();
}

/** Requires a specific permission key. Must be used after requireAuth. */
export function requirePermission(key: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const snap = req.auth?.snapshot;
    if (!snap) return res.status(401).json({ error: 'Not authenticated' });
    if (snap.isSuperAdmin || snap.permissions.has(key)) return next();
    return res.status(403).json({ error: `Missing permission: ${key}` });
  };
}

/** Requires the user to be the Super Admin (the single env-designated user). */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.auth.snapshot.isSuperAdmin) {
    return res.status(403).json({ error: 'Super Admin only' });
  }
  next();
}

/** Helper for routes that need to check hierarchy against a target tier. */
export function canAssign(actor: PermissionSnapshot, targetTier: number): boolean {
  return canAssignTier(actor, targetTier);
}