/**
 * Domain types — mirror the mobile app's src/types/index.ts.
 */

export type UserRole = 'patient' | 'admin';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  state: string;
}

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship?: string;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  nric: string;
  address: Address;
  emergencyContact: EmergencyContact;
  role: UserRole;
  createdAt: string;
}
