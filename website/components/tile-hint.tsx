"use client"

import * as React from "react"

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

const MOBILE_COOKIE_NAME = "tile_hint_mobile_seen"

function hasCookie(name: string) {
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${name}=`))
}

// Mobile + tablet hint (the wide desktop gutter gets the curly arrow instead).
// Shows on the first visit only — a cookie set on first render keeps it from
// reappearing the next time the visitor comes back.
export function MobileTileHint() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    if (hasCookie(MOBILE_COOKIE_NAME)) return
    setVisible(true)
    document.cookie = `${MOBILE_COOKIE_NAME}=1; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
  }, [])

  if (!visible) return null

  return (
    <p className="-mb-7 w-full max-w-7xl text-center font-sans text-[11px] leading-snug text-muted-foreground xl:hidden">
      tap a picture, then hover over a tile to see the smaller ones that
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
