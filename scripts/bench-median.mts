// Throwaway benchmark: how expensive is the median histogram, really?
// Mirrors MedianAccumulator from lib/roboflow-ingest.ts at the frame size a
// 640x640 Roboflow export lands on after the MEDIAN_MAX_PIXELS cap.

const MEDIAN_MAX_PIXELS = 262_144

function frame(w: number, h: number) {
  const pixels = w * h
  if (pixels <= MEDIAN_MAX_PIXELS) return { width: w, height: h }
  const scale = Math.sqrt(MEDIAN_MAX_PIXELS / pixels)
  return {
    width: Math.max(2, Math.round(w * scale)),
    height: Math.max(2, Math.round(h * scale)),
  }
}

class MedianAccumulator {
  private readonly counts: Uint16Array
  private samples = 0
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.counts = new Uint16Array(width * height * 3 * 256)
  }
  add(rgb: Buffer): void {
    const counts = this.counts
    for (let i = 0; i < rgb.length; i++) counts[i * 256 + rgb[i]] += 1
    this.samples += 1
  }
  median(): Buffer {
    const half = Math.floor(this.samples / 2) + 1
    const values = this.width * this.height * 3
    const out = Buffer.allocUnsafe(values)
    for (let i = 0; i < values; i++) {
      const base = i * 256
      let cumulative = 0
      let value = 255
      for (let v = 0; v < 256; v++) {
        cumulative += this.counts[base + v]
        if (cumulative >= half) {
          value = v
          break
        }
      }
      out[i] = value
    }
    return out
  }
}

const { width, height } = frame(640, 640)
const values = width * height * 3
console.log(`frame ${width}x${height}  values=${values.toLocaleString()}`)
console.log(`histogram = ${((values * 256 * 2) / 1e6).toFixed(0)} MB`)

const t0 = performance.now()
const acc = new MedianAccumulator(width, height)
console.log(`alloc: ${(performance.now() - t0).toFixed(0)} ms`)

// Realistic-ish pixel data: random bytes defeat any lucky locality, which is
// the point — real photos are not uniform but they do spread across the bins.
const image = Buffer.allocUnsafe(values)
for (let i = 0; i < values; i++) image[i] = (Math.random() * 256) | 0

const N = 100
const t1 = performance.now()
for (let i = 0; i < N; i++) acc.add(image)
const perAdd = (performance.now() - t1) / N
console.log(`add(): ${perAdd.toFixed(1)} ms/image`)
console.log(`  -> 1000 images: ${((perAdd * 1000) / 1000).toFixed(1)} s`)
console.log(`  -> 4000 images: ${((perAdd * 4000) / 1000).toFixed(1)} s  (MEDIAN_SAMPLE_MAX)`)

const t2 = performance.now()
acc.median()
console.log(`median(): ${((performance.now() - t2) / 1000).toFixed(2)} s`)
