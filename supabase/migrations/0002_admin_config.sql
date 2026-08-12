-- Admin password for the "Publish & share" gate, stored HASHED in Supabase so it
-- can be changed without a redeploy. RLS denies everything; only the service role
-- (the /api/mosaic/admin/unlock route) reads it. The stored value is
-- sha256('mosaic-admin:v1:' || password), which matches hashAdminPassword() in
-- lib/mosaic-admin.ts so the server and the dashboard agree.
--
-- Apply this the same way as 0001 (Supabase SQL editor or psql).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_config (
  id            text primary key,
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

-- Server-only: no policies, so anon/authenticated get nothing; the service role
-- bypasses RLS.
alter table public.admin_config enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- SET / CHANGE THE ADMIN PASSWORD
-- Replace 'CHANGE-ME' with your password and run JUST this statement. The
-- plaintext is only in this query — the table stores the hash. Re-run any time
-- to rotate (rotating also invalidates existing admin sessions).
-- ─────────────────────────────────────────────────────────────────────────────
-- insert into public.admin_config (id, password_hash)
-- values (
--   'admin',
--   encode(extensions.digest('mosaic-admin:v1:' || 'CHANGE-ME', 'sha256'), 'hex')
-- )
-- on conflict (id) do update
--   set password_hash = excluded.password_hash, updated_at = now();
