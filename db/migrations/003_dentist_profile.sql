-- ============================================================
-- 003_dentist_profile.sql
-- Adds dentist-specific profile fields to users.
-- All nullable — non-dentist users leave them NULL.
-- Idempotent.
-- ============================================================

BEGIN;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "dentist_title"     text,
  ADD COLUMN IF NOT EXISTS "dentist_specialty" text,
  ADD COLUMN IF NOT EXISTS "dentist_bio"       text,
  ADD COLUMN IF NOT EXISTS "dentist_initials"  text,
  ADD COLUMN IF NOT EXISTS "dentist_accent"    text;

COMMIT;