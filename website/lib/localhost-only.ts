const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "")
}

export function isLocalhostHost(host: string | null): boolean {
  if (!host) return false

  const value = host.trim().toLowerCase()
  if (normalizeHostname(value) === "::1") return true

  try {
    return LOCAL_HOSTS.has(normalizeHostname(new URL(`http://${value}`).hostname))
  } catch {
    const withoutPort = value.split(":")[0]
    return LOCAL_HOSTS.has(normalizeHostname(withoutPort))
  }
}
