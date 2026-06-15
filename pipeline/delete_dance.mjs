import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BUCKET = process.env.KNICKS_PHOTO_BUCKET || "knicks-mosaic"
const DRY = process.argv.includes("--dry-run")
const here = path.dirname(fileURLToPath(import.meta.url))

for (const f of [".env", ".env.local"]) {
  try {
    for (const line of fs.readFileSync(path.join(here, "..", f), "utf8").split(/\r?\n/)) {
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
const enc = (p) => p.split("/").map(encodeURIComponent).join("/")
const objUrl = (p) => `${url}/storage/v1/object/${BUCKET}/${enc(p)}`

const FILTER = /dancer|dance team|dance bracket|city dancers|kcd\b/i
const field = (p) => [p.gallery, p.galleryTitle].filter(Boolean).join(" || ")

// ── Fetch current manifest + signatures ──────────────────────────────────────
const manifest = await (await fetch(objUrl("manifest.json"), { headers: auth })).json()
const sigRes = await fetch(objUrl("signatures.bin"), { headers: auth })
if (!sigRes.ok) throw new Error(`signatures fetch failed ${sigRes.status}`)
const sig = Buffer.from(await sigRes.arrayBuffer())

const photos = manifest.photos
const n = photos.length
if (sig.length % n !== 0) throw new Error(`signatures.bin (${sig.length}) not divisible by photo count (${n})`)
const SIG_BYTES = sig.length / n
console.log(`photos: ${n}, signatures.bin: ${sig.length} bytes, SIG_BYTES: ${SIG_BYTES}`)

const removeIdx = []
const keepPhotos = []
const keepChunks = []
for (let i = 0; i < n; i++) {
  if (FILTER.test(field(photos[i]))) {
    removeIdx.push(i)
  } else {
    keepPhotos.push(photos[i])
    keepChunks.push(sig.subarray(i * SIG_BYTES, (i + 1) * SIG_BYTES))
  }
}
console.log(`removing: ${removeIdx.length}, keeping: ${keepPhotos.length}`)
if (keepPhotos.length + removeIdx.length !== n) throw new Error("count mismatch")

// ── Back up current manifest + signatures locally ────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupDir = path.join(here, "data", `knicks-mosaic-backup-${stamp}`)
fs.mkdirSync(backupDir, { recursive: true })
fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(manifest))
fs.writeFileSync(path.join(backupDir, "signatures.bin"), sig)
fs.writeFileSync(
  path.join(backupDir, "removed-ids.json"),
  JSON.stringify(removeIdx.map((i) => ({ id: photos[i].id, fullPath: photos[i].fullPath, galleryTitle: photos[i].galleryTitle })), null, 2)
)
console.log(`backup written: ${path.relative(path.join(here, ".."), backupDir)}`)

if (DRY) {
  console.log("DRY RUN — no uploads or deletes performed.")
  process.exit(0)
}

// ── Build + upload new manifest + signatures (bump version) ───────────────────
const newSig = Buffer.concat(keepChunks, keepPhotos.length * SIG_BYTES)
const newManifest = { version: new Date().toISOString(), photos: keepPhotos }

async function put(objPath, body, contentType) {
  const r = await fetch(objUrl(objPath), {
    method: "POST",
    headers: { ...auth, "content-type": contentType, "x-upsert": "true", "cache-control": "31536000" },
    body,
  })
  if (!r.ok) throw new Error(`upload ${objPath} failed ${r.status}: ${await r.text()}`)
}
await put("signatures.bin", newSig, "application/octet-stream")
await put("manifest.json", Buffer.from(JSON.stringify(newManifest)), "application/json")
console.log(`uploaded new manifest (version ${newManifest.version}) + signatures (${newSig.length} bytes)`)

// ── Delete removed objects (thumbs + originals) in batches ────────────────────
const prefixes = []
for (const i of removeIdx) {
  const p = photos[i]
  prefixes.push(`thumbs/${p.id}.jpg`)
  prefixes.push(p.fullPath) // originals/<id>
}
console.log(`deleting ${prefixes.length} storage objects...`)

let deleted = 0
const BATCH = 500
for (let i = 0; i < prefixes.length; i += BATCH) {
  const chunk = prefixes.slice(i, i + BATCH)
  const r = await fetch(`${url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ prefixes: chunk }),
  })
  if (!r.ok) {
    console.warn(`  batch ${i}-${i + chunk.length} failed ${r.status}: ${(await r.text()).slice(0, 200)}`)
    continue
  }
  const body = await r.json().catch(() => [])
  deleted += Array.isArray(body) ? body.length : chunk.length
  console.log(`  deleted ${deleted}/${prefixes.length}`)
}

console.log(`\nDone. Removed ${removeIdx.length} dance photos. ${keepPhotos.length} remain. Deleted ~${deleted} objects.`)
console.log(`Backup + removed-ids at: ${path.relative(path.join(here, ".."), backupDir)}`)
