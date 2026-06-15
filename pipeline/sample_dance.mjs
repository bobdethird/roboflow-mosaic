import fs from "node:fs"
import path from "node:path"

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
const m = await (await fetch(`${url}/storage/v1/object/${BUCKET}/manifest.json`, { headers: auth })).json()

const FILTER = /dancer|dance team|dance bracket|city dancers|kcd\b/i
const field = (p) => [p.gallery, p.galleryTitle].filter(Boolean).join(" || ")
const dance = m.photos.filter((p) => FILTER.test(field(p)))
console.log(`dance photos matched: ${dance.length} / ${m.photos.length}`)

// Deterministic "random" spread: evenly sample 10 across the matched set so we
// see different galleries, not 10 from one shoot. (Date.now/Math.random avoided.)
const N = 10
const picks = []
for (let i = 0; i < N; i++) picks.push(dance[Math.floor((i + 0.5) * dance.length / N)])

const outDir = new URL("../ballerina-sample/", import.meta.url)
fs.mkdirSync(outDir, { recursive: true })
const enc = (p) => p.split("/").map(encodeURIComponent).join("/")

let n = 0
for (const p of picks) {
  const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${enc(p.fullPath)}`, { headers: auth })
  if (!r.ok) { console.warn(`  fail ${p.id} ${r.status}`); continue }
  const buf = Buffer.from(await r.arrayBuffer())
  const fname = `${String(++n).padStart(2, "0")}-${p.id}.jpg`
  fs.writeFileSync(new URL(fname, outDir), buf)
  console.log(`  ${fname}  <-  ${p.galleryTitle}`)
}
console.log(`\nSaved ${n} images to ballerina-sample/`)
