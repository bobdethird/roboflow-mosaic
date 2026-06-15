import fs from "node:fs"

const BUCKET = process.env.KNICKS_PHOTO_BUCKET || "knicks-mosaic"

for (const f of [".env", ".env.local"]) {
  try {
    for (const line of fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=")
      if (i < 0 || line.trim().startsWith("#")) continue
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")
const key = process.env.SUPABASE_SECRET_KEY
const auth = { apikey: key, authorization: `Bearer ${key}` }

const r = await fetch(`${url}/storage/v1/object/${BUCKET}/manifest.json`, { headers: auth })
if (!r.ok) {
  console.error("manifest fetch", r.status, await r.text())
  process.exit(1)
}
const m = await r.json()
console.log("version:", m.version)
console.log("photo count:", m.photos.length)

const gals = {}
for (const p of m.photos) {
  const g = p.galleryTitle || p.gallery || "?"
  gals[g] = (gals[g] || 0) + 1
}
const sorted = Object.entries(gals).sort((a, b) => b[1] - a[1])
console.log("galleries:", sorted.length)
for (const [g, c] of sorted) console.log(`  ${String(c).padStart(4)}  ${g}`)

console.log("--- sample photo ---")
console.log(JSON.stringify(m.photos[0], null, 2))

// Highlight anything that looks ballerina/dance related by metadata
const KW = /ballerina|ballet|dancer|dance|city dancer/i
const hits = m.photos.filter((p) => KW.test([p.gallery, p.galleryTitle, p.sourceUrl].filter(Boolean).join(" ")))
console.log(`--- keyword (ballerina/ballet/dance) metadata hits: ${hits.length} ---`)
const hitGals = {}
for (const p of hits) {
  const g = p.galleryTitle || p.gallery || "?"
  hitGals[g] = (hitGals[g] || 0) + 1
}
for (const [g, c] of Object.entries(hitGals).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${g}`)
