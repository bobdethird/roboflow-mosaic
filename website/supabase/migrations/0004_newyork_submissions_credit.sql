-- "A Mosaic of New York" photo submissions now come straight from the site's
-- in-page upload flow (app/api/newyork-submissions) instead of a Google Form.
-- That flow writes the file to the private `newyork-submissions` Storage bucket
-- and inserts one row here per photo, all with the service key (RLS stays deny-
-- all; only the server reads/writes). These columns back that flow.
--
-- Apply the same way as the earlier migrations (Supabase SQL editor or psql).

alter table public.newyork_submissions
  -- Full name the submitter optionally wants displayed; null means "don't credit".
  add column if not exists credit_name text,
  -- Groups the (up to 5) photos uploaded together in one submission.
  add column if not exists batch_id    uuid,
  -- Salted hash of the submitter IP — used only for the per-IP hourly upload
  -- rate limit, never the raw IP. Matches hashIp() in lib/mosaic-share-store.ts.
  add column if not exists ip_hash     text;

-- Rate-limit scans: this IP's rows in the last hour (per-IP cap) and all rows in
-- the last hour (global cap). Both filter on submitted_at.
create index if not exists newyork_submissions_ip_recent_idx
  on public.newyork_submissions (ip_hash, submitted_at);
create index if not exists newyork_submissions_submitted_at_idx
  on public.newyork_submissions (submitted_at);
