-- Zoom-to-reveal: per-tile geometry artifact.
--
-- The zoom viewer needs to know where every tile sits (center, angle, source
-- photo) to repaint the real photos in place as you zoom. That geometry is
-- written to the private mosaics-shared bucket alongside the composite + hit-map
-- and streamed back through the public /m/[id]/geometry route. This column holds
-- its object path; it's nullable so mosaics published before the zoom feature
-- keep working (they just have no overlay — the route returns 404 and the viewer
-- zooms the base image only).
--
-- Apply with either:
--   supabase db push                      (if using the Supabase CLI)
--   psql "$SUPABASE_DB_URL" -f 0003_mosaics_geometry.sql
-- or paste into the Supabase dashboard SQL editor.

alter table public.mosaics
  add column if not exists geometry_path text;
