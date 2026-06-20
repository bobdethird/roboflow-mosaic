# Shareable Mosaics — Design Spec (Phase 1)

A way to turn any generated mosaic into a public, shareable link. You generate a
mosaic, hit **Share**, and get a `/m/<id>` URL. Anyone with the link sees the
mosaic in a custom view (with the same hover-to-reveal-source-frame experience),
and the link unfurls with a preview image in iMessage / Discord / Twitter / Slack.

For Phase 1 everything is **anonymous**: anybody can create, anybody can view,
links are **immutable** (the creator cannot delete), and only an admin can take
a mosaic down.

---

## The key insight

The artifact we want to share **already exists**. When you generate a mosaic,
`canvas-hero.tsx` produces everything a self-contained, viewable mosaic needs:

- the **composite mosaic image** (canvas → blob; the PNG export path already does
  this), and
- a **hit-map** (`assignment` + `centers` + `tileIds` → the same `GalleryTileMap`
  shape: `{ w, h, cols, rows, grid, tiles }`).

And the **view experience already exists** too — `MosaicGallery` renders exactly
that artifact with the hover popup. The tile URLs inside the hit-map already
point through the `/api/mosaic/[...path]` proxy, so a shared mosaic's hover data
keeps working with zero extra plumbing.

So shareable mosaics is **not a rendering problem** — the renderer, artifact
format, and viewer are done. It's a **persistence + routing problem**.

## The one real gap

`/api/bake/save` is the closest existing thing, but it's **localhost-only and
writes to the local filesystem** (`public/gallery`). On Vercel that's read-only
and ephemeral — it can't be the share backend. The website currently touches
Supabase **only** through the read proxy (Storage REST + secret key); there's no
DB client and no write path. That write path is the thing we actually build.

---

## Locked decisions

| Decision | Choice |
| --- | --- |
| Index store | **Supabase Postgres table** (`mosaics`) |
| URL format | **Short slug** — `/m/<nanoid-8>`, e.g. `/m/a1b2c3d4` |
| Public unfurl image | **Dedicated `/m/[id]/og.jpg` route** (bucket stays private) |
| Dedupe | **Yes** — content-hash, idempotent re-share |
| Auth | **None in Phase 1** — fully anonymous |
| Deletion | **Admin-only** (a `deleted` flag); no public delete endpoint |

---

## Data model — Postgres `mosaics` table

```
id           text  primary key      -- nanoid(8), e.g. "a1b2c3d4" → /m/a1b2c3d4
created_at   timestamptz default now()
collection   text                   -- which library: 'knicks' | 'nyc' | ...
w, h         int                    -- composite image pixel dims (masonry + OG)
image_path   text                   -- shared/<id>/image.jpg in Storage
tilemap_path text                   -- shared/<id>/tilemap.json
content_hash text                   -- sha256 of the composite image
ip_hash      text                   -- hashed creator IP (rate limiting + abuse, not PII)
deleted      boolean default false
-- Phase 2 stubs, nullable now:
user_id      uuid null
display_name text null
```

- `content_hash` gets a **unique index over non-deleted rows** (partial unique
  index) so re-sharing an identical mosaic returns the existing link.
- **RLS posture:** enable RLS and grant the `anon` / `authenticated` roles
  *nothing*. Every read and write goes through server routes using the service
  key — the same trust boundary the proxy already establishes. The browser never
  touches the table or the bucket directly.

## Storage

New **private** bucket `mosaics-shared`:

```
shared/<id>/image.jpg      -- the composite mosaic (JPEG)
shared/<id>/tilemap.json   -- the GalleryTileMap hit-map
```

Keeping user-generated content in its own bucket (separate from `knicks-clips`
source footage) keeps lifecycle and permissions clean. Add it to
`isMosaicBucket()` so the existing proxy can serve the tilemap + page-side reads.

---

## Create flow — `POST /api/mosaic/share` (nodejs)

The composite + hit-map already exist post-`handleGenerate`. The new **Share**
button:

1. `canvas.toBlob('image/jpeg', ~0.9)` for the composite (JPEG, **not** the
   current PNG export — far smaller, mosaics compress well).
2. Build the `GalleryTileMap` from `assignment` / `centers` / `tileIds`.
   **Factor this out of `mosaic-bake`'s save path into a shared helper** so
   create-share and `/bake` produce byte-identical tilemaps.
3. POST as **multipart** (image as a file part, tilemap + metadata as fields —
   avoids base64's 33% bloat).
4. Server:
   - same-origin guard (reuse the proxy's `isSameOriginRequest`),
   - **IP rate-limit** — `count(*) where ip_hash = ? and created_at > now() - interval '1 hour'`,
   - validate **JPEG magic bytes** + **size cap** (~5 MB) + **max dims**,
   - compute `content_hash`; if a non-deleted row with that hash exists,
     **return its existing link** (re-clicking Share is idempotent),
   - else generate nanoid (retry on PK collision), upload both objects, insert
     the row,
   - return `{ id, url }`.
5. Client: show link + copy button, plus `navigator.share` on mobile.

## View flow — `/m/[id]` (server component)

- Fetch row by id (service key) → `notFound()` if missing or `deleted`.
- Render a `SharedMosaicView` that **reuses MosaicGallery's hover popup** against
  the stored image + tilemap.
- The tile URLs inside the tilemap still resolve through the existing **private**
  proxy, so "hover to reveal the source frame" works unchanged.

---

## ⚠️ The catch: unfurl vs. the anti-hotlink proxy

`/api/mosaic/[...path]` **deliberately rejects cross-site requests**
(`isSameOriginRequest`). But link-unfurl crawlers — iMessage, Discord, Twitter,
Slack — fetch the `og:image` **cross-site, with no cookie**. If the OG image
points at the gated proxy, **every shared link previews as a broken 403** — which
kills the exact "preloads the mosaic" magic we're after.

So shared mosaics need a **separate, intentionally public read path** for the
*composite image only*:

- **`/m/[id]/og.jpg`** — a dedicated route that serves only the composite,
  **without** the same-origin guard. It checks `deleted` first, then streams the
  object from the private bucket using the service key, hard-cached.
- The bucket stays private; nothing else in it is exposed.
- The individual **source frames stay gated** through the existing proxy
  (crawlers don't hover; only humans on the page do). Only the one composite
  image goes public.

This is the right model anyway — these *are* public posts — but it's a deliberate
fork from the source-clip security stance, not an accident.

`generateMetadata()` then sets `og:image` → `/m/[id]/og.jpg` (absolute, `w`×`h`)
plus `summary_large_image`, and the link unfurls.

---

## Abuse controls

The only genuinely new risk is **anonymous public writes**.

- **Rate limit** per `ip_hash` — for MVP, count rows from the same `ip_hash` in
  the last hour against the table (no new infra; swap to Upstash/Redis only if
  volume demands it).
- **Size cap** (~5 MB) + **JPEG magic-byte check** + **max dims**.
- Admin `deleted` flag handles bad content reactively; **no public delete
  endpoint**.

---

## Build order

1. Migration — `mosaics` table + RLS + partial unique index on `content_hash`.
2. Bucket `mosaics-shared` + add to `isMosaicBucket()`.
3. Shared tilemap helper (refactor out of `mosaic-bake`).
4. `POST /api/mosaic/share`.
5. Share button in `canvas-hero`.
6. `/m/[id]` view (`SharedMosaicView` reusing the hover popup).
7. `/m/[id]/og.jpg` + `generateMetadata`.
8. Test the full loop: generate → share → open in incognito → confirm unfurl.

## Deferred to Phase 2 (the social layer)

- Supabase Auth, `user_id` / username.
- Anonymous-vs-named posting toggle.
- A `/feed` of recent mosaics.

The schema stubs (`user_id`, `display_name`) are already in place for it.

---

## Open questions for review

- **Rate-limit thresholds** — what counts as abusive? (e.g. N shares/hour/IP.)
- **Size cap + max dims** — confirm ~5 MB / what max resolution.
- **Collection provenance** — is `collection` enough, or do we also want to store
  generation params (cell size, weighting) for a future "remix" feature?
- **`ip_hash` salt** — where the salt lives (env var) so hashes aren't reversible.
- **OG card copy** — title/description text for the unfurl.
