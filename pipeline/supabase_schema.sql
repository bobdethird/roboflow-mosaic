-- Run ONCE in the Supabase dashboard → SQL Editor (the secret key can't create
-- tables over the API). After this, the diversity pipeline auto-upserts rows.

-- The YouTube videos we scrape: name + link (plus light provenance).
create table if not exists public.youtube_videos (
  video_id    text primary key,
  title       text,
  url         text not null,
  source_query text,
  clips_count int  default 0,
  scraped_at  timestamptz default now()
);

-- One row per accepted clip, with the end-frame's color metric.
create table if not exists public.clips (
  clip_id       text primary key,
  source_video  text references public.youtube_videos(video_id),
  url           text,
  title         text,
  end_seconds   int,
  end_timestamp text,
  clip_start    text,
  duration      real,
  color_hex     text,
  r int, g int, b int,             -- end-frame dominant color (sRGB)
  lab_l real, lab_a real, lab_b real,
  clip_path     text,              -- storage object path (knicks-clips bucket)
  frame_path    text,
  created_at    timestamptz default now()
);

create index if not exists clips_source_video_idx on public.clips(source_video);
