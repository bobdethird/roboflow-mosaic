-- Shareable mosaics (Phase 1).
--
-- One row per published mosaic. The composite image + hover hit-map live in the
-- private `mosaics-shared` Storage bucket; this table is the index that the
-- server routes read/write with the service key. RLS is enabled with NO
-- policies, so the anon/authenticated roles get nothing — every access goes
-- through our server routes (the service role bypasses RLS). This mirrors the
-- trust boundary the /api/mosaic proxy already establishes for the photo
-- buckets: the secret key never leaves the server.
--
-- Apply with either:
--   supabase db push                      (if using the Supabase CLI)
--   psql "$SUPABASE_DB_URL" -f 0001_create_mosaics.sql
-- or paste into the Supabase dashboard SQL editor.

create table if not exists public.mosaics (
  -- Short nanoid-style slug, e.g. "a1b2c3d4" → /m/a1b2c3d4.
  id            text primary key,
  created_at    timestamptz not null default now(),
  -- Which photo collection (bucket) the tiles came from, e.g. 'knicks-mosaic'.
  collection    text not null,
  -- Stored composite image pixel dims (drive the view aspect ratio + OG card).
  w             integer not null,
  h             integer not null,
  -- Object paths within the mosaics-shared bucket.
  image_path    text not null,
  tilemap_path  text not null,
  -- sha256 of the composite image bytes: dedupe + idempotent re-share.
  content_hash  text not null,
  -- Salted hash of the creator IP (rate limiting / abuse triage; not PII).
  ip_hash       text,
  -- Admin-only soft delete. No public delete path; flipping this hides the
  -- mosaic from every read (the routes filter deleted = false).
  deleted       boolean not null default false,
  -- Phase 2 stubs (accounts / named posting). Nullable, unused in Phase 1.
  user_id       uuid,
  display_name  text
);

-- Idempotent re-share: at most one live row per identical composite image, so
-- clicking Publish twice on the same mosaic returns the existing link instead
-- of minting a duplicate. Deleted rows are excluded so a re-publish after an
-- admin takedown is still possible.
create unique index if not exists mosaics_content_hash_live
  on public.mosaics (content_hash)
  where (deleted = false);

-- Recent-first listing (future feed) and the per-IP rate-limit window scan.
create index if not exists mosaics_created_at_idx
  on public.mosaics (created_at desc);
create index if not exists mosaics_ip_hash_idx
  on public.mosaics (ip_hash, created_at desc);

-- Server-only: deny everything to anon/authenticated. The service role used by
-- the API routes bypasses RLS, so the routes are the only way in or out.
alter table public.mosaics enable row level security;

-- Private bucket for the published composites + hit-maps. Served back out only
-- through the dedicated public /m/[id]/image and /m/[id]/tilemap routes (which
-- check `deleted` and stream with the service key) — never world-readable by URL.
insert into storage.buckets (id, name, public)
values ('mosaics-shared', 'mosaics-shared', false)
on conflict (id) do nothing;
