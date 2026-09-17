/**
 * JWT signing and verification.
 */

import jwt from 'jsonwebtoken';

import { config } from '../config';

export interface JwtPayload {
  sub: string;      // user id
  username: string;
  email: string;
}

const EXPIRES_IN = '30d';

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { sub, username, email } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof username !== 'string' || typeof email !== 'string') {
      return null;
    }
    return { sub, username, email };
  } catch {
    return null;
  }
}

/** Reads "Authorization: Bearer xxx" and returns the raw token, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}