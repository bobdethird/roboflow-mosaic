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
const m = await (await fetch(`${url}/storage/v1/object/${BUCKET}/manifest.json`, { headers: auth })).json()

console.log("sample photo keys:", Object.keys(m.photos[0]).join(", "))
console.log("sample photo:", JSON.stringify(m.photos[0]))

const field = (p) => [p.gallery, p.galleryTitle].filter(Boolean).join(" || ")
const A = /ballerina|ballet|dancer|dance|city dancer/i   // original broad
const B = /dancer|dance team|dance bracket|city dancers|kcd\b/i  // tight
const a = m.photos.filter((p) => A.test(field(p)))
const b = m.photos.filter((p) => B.test(field(p)))
console.log(`\nfilter A (orig broad): ${a.length}`)
console.log(`filter B (tight):      ${b.length}`)

// in B but not A
const onlyB = b.filter((p) => !A.test(field(p)))
console.log(`\nin B not A: ${onlyB.length}`)
const g1 = {}
for (const p of onlyB) { const t = field(p); g1[t] = (g1[t] || 0) + 1 }
for (const [t, c] of Object.entries(g1).sort((x, y) => y[1] - x[1]).slice(0, 15)) console.log(`  ${String(c).padStart(4)}  ${t}`)

// how many photos have NO gallery field at all
const noGallery = m.photos.filter((p) => !p.gallery && !p.galleryTitle)
console.log(`\nphotos with no gallery metadata: ${noGallery.length}`)
