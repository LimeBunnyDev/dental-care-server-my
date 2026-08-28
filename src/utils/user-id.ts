// src/utils/user-id.ts  — SERVER project (dental-care-server)

export const ROLE_IDS = {
  admin: '00',
  dentist: '01',
  delegator: '02',
  customer: '03',
} as const;

export type UserRoleName = keyof typeof ROLE_IDS;

export function roleToId(role: string): string {
  return ROLE_IDS[role as UserRoleName] ?? '03';
}

export function isStaffRole(role: string): boolean {
  return role === 'admin' || role === 'dentist' || role === 'delegator';
}

export function birthDateToPrefix(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

export function buildUserId(prefix: string, role: string, seq: number): string {
  return `${prefix}${roleToId(role)}${String(seq).padStart(6, '0')}`;
}

export function rebaseUserId(currentUserId: string, newBirthDateISO: string): string {
  const suffix = currentUserId.slice(8);
  return birthDateToPrefix(newBirthDateISO) + suffix;
}
