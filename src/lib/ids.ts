/**
 * ID generation. Short, URL-safe, no collisions in practice.
 * Format: u_<base36 timestamp><6 random base36 chars>
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function rand(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newUserId(): string {
  return 'u_' + Date.now().toString(36) + rand(6);
}

export function newRoleId(): string {
  return 'role_' + rand(10);
}

export function newPermissionId(): string {
  return 'perm_' + rand(10);
}

export function newAppointmentId(): string {
  return 'apt_' + Date.now().toString(36) + rand(6);
}