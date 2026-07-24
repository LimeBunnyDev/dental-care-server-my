/**
 * SQL row → domain object mapping for users.
 */

import type { PublicUser } from '../types';

export function rowToPublicUser(row: any): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    nric: row.nric,
    address: {
      line1: row.address_line1,
      line2: row.address_line2 ?? undefined,
      city: row.city,
      postcode: row.postcode,
      state: row.state,
    },
    emergencyContact: {
      name: row.ec_name,
      phone: row.ec_phone,
      relationship: row.ec_relationship ?? undefined,
    },
    role: row.role,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  };
}
