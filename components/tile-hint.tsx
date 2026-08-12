"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"

const COOKIE_NAME = "tile_hint_dismissed"
// Keep the cookie around for a year so returning visitors don't see it again.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function hasDismissedCookie() {
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${COOKIE_NAME}=`))
}

function setDismissedCookie() {
  document.cookie = `${COOKIE_NAME}=1; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
}

function hasCookie(name: string) {
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${name}=`))
}

const INTRO_COOKIE_NAME = "mosaic_intro_seen"
// Below this width counts as "mobile/tablet" - matches the xl breakpoint the
// other hints use to split touch screens from the wide desktop gutter.
const MOBILE_MEDIA_QUERY = "(max-width: 1279px)"

const INTRO_DEFAULT_DESCRIPTION =
  "Tap a picture to open it, then drag your finger across it to reveal the smaller photos that make up the whole."

// One-time mobile-only welcome modal for surfaces that still need an intro.
// The homepage intentionally no longer mounts this component.
export function MobileIntroAnnouncement({
  cookieName = INTRO_COOKIE_NAME,
  description = INTRO_DEFAULT_DESCRIPTION,
}: {
  cookieName?: string
  description?: string
} = {}) {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    if (hasCookie(cookieName)) return
    if (!window.matchMedia(MOBILE_MEDIA_QUERY).matches) return
    // Client-only check (cookie + viewport) that must run post-mount to avoid a
    // hydration mismatch - a deliberate, one-shot reveal, not a cascading update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(true)
  }, [cookieName])

  const dismiss = React.useCallback(() => {
    document.cookie = `${cookieName}=1; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
    setVisible(false)
  }, [cookieName])

  React.useEffect(() => {
    if (!visible) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [visible])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 font-sans backdrop-blur-sm xl:hidden"
      onClick={dismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How it works"
        className="w-full max-w-sm rounded-2xl border bg-background p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-sans text-xl leading-tight font-semibold tracking-tight text-foreground">
          how it works
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground">
          {description}
        </p>
        <Button className="mt-5 w-full" onClick={dismiss}>
          got it
        </Button>
      </div>
    </div>
  )
}

// Mobile + tablet hint (the wide desktop gutter gets the curly arrow instead).
// Always visible on small screens — it's a persistent nudge, never dismissed.
export function MobileTileHint() {
  return (
    <p className="-mb-7 w-full max-w-7xl text-center font-sans text-[11px] leading-snug text-muted-foreground xl:hidden">
      tap a picture once, then hover over tiles to see the smaller ones that
      comprise the whole
    </p>
  )
}

// Static hand-drawn nudge in the left margin, pointing right into the first
// mosaic so visitors notice the hover-to-peek interaction. Desktop only (it
// lives in the page gutter, which only exists on wide screens). Stays put for
// the whole first visit, then won't return on reloads/revisits (cookie-gated).
export function TileHint() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    if (hasDismissedCookie()) return

    // Client-only cookie check; runs post-mount to avoid a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(true)
    setDismissedCookie()
  }, [])

  if (!visible) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-24 right-full z-40 mr-1.5 hidden w-24 flex-col items-end gap-1.5 text-right text-foreground xl:flex"
    >
      <span className="text-xs leading-tight">Hover to see tiles</span>
      {/* Curly arrow looping rightward toward the first mosaic. */}
      <svg
        width="80"
        height="48"
        viewBox="0 0 120 72"
        fill="none"
        className="text-foreground"
      >
        <path
          d="M6 16c26-6 31 26 9 29-14 2-17-15-1-18 22-4 45 12 95 40"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M96 53l13 14-17 1"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
