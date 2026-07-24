/**
 * Seeds the 4 demo dentists. Idempotent.
 */

import { pool } from './pool';

const DENTISTS = [
  { id: 'dentist_chen', name: 'Dr. Sarah Chen', title: 'DDS', specialty: 'General & Cosmetic',
    bio: '12 years of experience in family and cosmetic dentistry.', initials: 'SC', accent_color: '#0EA5E9' },
  { id: 'dentist_patel', name: 'Dr. Arjun Patel', title: 'DMD, MS', specialty: 'Orthodontics',
    bio: 'Board-certified orthodontist. Specializes in clear aligners and modern braces.', initials: 'AP', accent_color: '#10B981' },
  { id: 'dentist_garcia', name: 'Dr. Maya Garcia', title: 'DDS', specialty: 'Endodontics',
    bio: 'Root-canal specialist with a famously gentle touch.', initials: 'MG', accent_color: '#F59E0B' },
  { id: 'dentist_okafor', name: 'Dr. James Okafor', title: 'DMD', specialty: 'Pediatric Dentistry',
    bio: 'Kids love Dr. James. He turns checkups into adventures.', initials: 'JO', accent_color: '#A855F7' },
];

async function main() {
  console.log('[seed] inserting demo dentists…');
  for (const d of DENTISTS) {
    await pool.query(
      `INSERT INTO dentists (id, name, title, specialty, bio, initials, accent_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name,
         specialty=EXCLUDED.specialty,
         bio=EXCLUDED.bio,
         initials=EXCLUDED.initials,
         accent_color=EXCLUDED.accent_color`,
      [d.id, d.name, d.title, d.specialty, d.bio, d.initials, d.accent_color]
    );
  }
  console.log(`[seed] ${DENTISTS.length} dentists ready.`);
  await pool.end();
}

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
