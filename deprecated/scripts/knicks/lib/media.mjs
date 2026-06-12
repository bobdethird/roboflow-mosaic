import fs from "node:fs/promises"
import path from "node:path"
import { createCanvas } from "@napi-rs/canvas"

import { CONFIG } from "../config.mjs"
import {
  captureJson,
  copyFile,
  ensureDir,
  exists,
  formatSeconds,
  run,
} from "./common.mjs"

export async function ensureReferenceImage() {
  const { referencePath, publicReferencePath } = CONFIG.paths
  if (!(await exists(referencePath))) {
    await ensureDir(path.dirname(referencePath))
    const { outputWidth, outputHeight } = CONFIG.mosaic
    const canvas = createCanvas(outputWidth, outputHeight)
    const ctx = canvas.getContext("2d")

    const grad = ctx.createLinearGradient(0, 0, outputWidth, outputHeight)
    grad.addColorStop(0, "#f58426")
    grad.addColorStop(0.48, "#ffffff")
    grad.addColorStop(1, "#006bb6")
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, outputWidth, outputHeight)

    ctx.fillStyle = "rgba(0,0,0,0.14)"
    ctx.fillRect(0, 0, outputWidth, outputHeight)

    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.lineJoin = "round"
    ctx.font = `900 ${Math.round(outputHeight * 0.22)}px Arial`
    ctx.lineWidth = Math.max(10, Math.round(outputHeight * 0.02))
    ctx.strokeStyle = "#006bb6"
    ctx.strokeText("KNICKS", outputWidth / 2, outputHeight * 0.48)
    ctx.fillStyle = "#ffffff"
    ctx.fillText("KNICKS", outputWidth / 2, outputHeight * 0.48)

    ctx.font = `700 ${Math.round(outputHeight * 0.055)}px Arial`
    ctx.fillStyle = "#f58426"
    ctx.fillText("VIDEO MOSAIC PROTOTYPE", outputWidth / 2, outputHeight * 0.68)

    await fs.writeFile(referencePath, canvas.toBuffer("image/png"))
  }
  await copyFile(referencePath, publicReferencePath)
  return referencePath
}

export function clipFrameSize() {
  const { outputWidth, outputHeight, gridCols, gridRows, tileLongEdge } =
    CONFIG.mosaic
  const cellAspect = outputWidth / gridCols / (outputHeight / gridRows)
  if (cellAspect >= 1) {
    return {
      width: tileLongEdge,
      height: Math.max(1, Math.round(tileLongEdge / cellAspect)),
    }
  }
  return {
    width: Math.max(1, Math.round(tileLongEdge * cellAspect)),
    height: tileLongEdge,
  }
}

export async function extractFrame(videoPath, t, outPath) {
  await ensureDir(path.dirname(outPath))
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      formatSeconds(t),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outPath,
    ],
    { quiet: true }
  )
}

export async function probeVideoSize(videoPath) {
  const info = await captureJson("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    videoPath,
  ])
  const stream = info.streams?.[0]
  const width = Number(stream?.width)
  const height = Number(stream?.height)
  if (!width || !height) {
    throw new Error(`Could not probe video size for ${videoPath}`)
  }
  return { width, height }
}

export function coverFrameSizeForSource(sourceSize, targetBox) {
  const oversample = CONFIG.mosaic.tileOversample ?? 1
  const box = {
    width: targetBox.width * oversample,
    height: targetBox.height * oversample,
  }
  const scale = Math.max(
    box.width / sourceSize.width,
    box.height / sourceSize.height
  )
  return {
    width: Math.max(
      1,
      Math.min(sourceSize.width, Math.ceil(sourceSize.width * scale))
    ),
    height: Math.max(
      1,
      Math.min(sourceSize.height, Math.ceil(sourceSize.height * scale))
    ),
  }
}

export async function createSyntheticVideo(outPath, index, tier = "filler") {
  await ensureDir(path.dirname(outPath))
  const hue = (index * 47) % 360
  const y = tier === "hero" ? 110 : 390
  const filter = [
    `testsrc2=size=1280x720:rate=30:duration=32`,
    `hue=h=${hue}`,
    `drawbox=x='mod(t*180\\,w)':y=${y}:w=180:h=180:color=#f58426@0.75:t=fill`,
    `drawbox=x=w-220-'mod(t*140\\,w)':y=390:w=180:h=180:color=#006bb6@0.75:t=fill`,
  ].join(",")
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    { quiet: true }
  )
}
