import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

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

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - clamp(t, 0, 1), 3)
}

export function formatSeconds(value) {
  return Number(value).toFixed(3)
}

export function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

export async function hashFile(filePath) {
  const handle = await fs.open(filePath, "r")
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

export async function run(command, args, options = {}) {
  const { cwd, env, input, allowFailure = false } = options
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
    child.on("error", reject)
    child.on("close", (code) => {
      const result = { code, stdout, stderr }
      if (code === 0 || allowFailure) {
        resolve(result)
      } else {
        const err = new Error(`${command} ${args.join(" ")} failed (${code})`)
        err.result = result
        reject(err)
      }
    })
    if (input) child.stdin.end(input)
  })
}

export async function captureBuffer(command, args, options = {}) {
  const { cwd, env, input, allowFailure = false } = options
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    let stderr = ""
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (!options.quiet) process.stderr.write(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      const result = { code, stdout: Buffer.concat(stdout), stderr }
      if (code === 0 || allowFailure) {
        resolve(result)
      } else {
        const err = new Error(`${command} ${args.join(" ")} failed (${code})`)
        err.result = result
        reject(err)
      }
    })
    if (input) child.stdin.end(input)
  })
}

export async function captureJson(command, args, options = {}) {
  const result = await run(command, args, { quiet: true, ...options })
  return JSON.parse(result.stdout)
}

export async function listFilesRecursive(root, predicate) {
  const out = []
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (!predicate || predicate(fullPath, entry.name)) {
        out.push(fullPath)
      }
    }
  }
  await visit(root)
  return out
}
