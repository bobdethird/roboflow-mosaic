"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// Admin login: posts the password to the unlock route, which sets the signed
// admin cookie on success. A full navigation to /knicks-mosaic then re-renders
// the page server-side with the cookie, so the Publish button appears.
export function AdminLoginForm() {
  const [password, setPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const onSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!password || submitting) return
      setSubmitting(true)
      setError(null)
      try {
        const res = await fetch("/api/mosaic/admin/unlock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        })
        if (!res.ok) {
          setError(
            res.status === 401
              ? "Incorrect password."
              : res.status === 503
                ? "Admin login isn’t configured yet."
                : `Login failed (${res.status}).`
          )
          return
        }
        window.location.href = "/knicks-mosaic"
      } catch {
        setError("Something went wrong. Try again.")
      } finally {
        setSubmitting(false)
      }
    },
    [password, submitting]
  )

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-3">
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Admin password"
        autoFocus
        autoComplete="current-password"
        aria-label="Admin password"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={!password || submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
