import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true })
}

export async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

export async function copyFile(src, dest) {
  await ensureDir(path.dirname(dest))
  await fs.copyFile(src, dest)
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

export function candidateKey(videoId, t) {
  return `${videoId}_${Math.round(t * 1000)}`
}

export function formatSeconds(value) {
  return Number(value).toFixed(3)
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - clamp(t, 0, 1), 3)
}

export function easeInOutCubic(t) {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export async function run(command, args, options = {}) {
  const { cwd, env, input, allowFailure = false, timeoutMs } = options
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (!options.quiet) process.stdout.write(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (!options.quiet) process.stderr.write(chunk)
    })
    const timeout =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM")
            setTimeout(() => child.kill("SIGKILL"), 1500).unref()
          }, timeoutMs)
        : null
    child.on("error", reject)
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout)
      const result = { code, stdout, stderr }
      if (code === 0 || allowFailure) {
        resolve(result)
      } else {
        const err = new Error(`${command} ${args.join(" ")} failed (${code})`)
        err.result = result
        reject(err)
      }
    })
    if (input) {
      child.stdin.end(input)
    }
  })
}

export async function captureJson(command, args, options = {}) {
  const result = await run(command, args, { quiet: true, ...options })
  return JSON.parse(result.stdout)
}
