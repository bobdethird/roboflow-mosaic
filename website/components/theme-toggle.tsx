"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"

// Shared toggler: flips between light and dark based on the resolved theme.
function useToggleTheme() {
  const { resolvedTheme, setTheme } = useTheme()
  return React.useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark")
  }, [resolvedTheme, setTheme])
}

// Fixed top-right icon button that toggles dark mode.
export function ThemeToggle() {
  const { resolvedTheme } = useTheme()
  const toggle = useToggleTheme()
  // Avoid a hydration mismatch: the resolved theme is only known on the client,
  // so render a stable icon until mounted.
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="fixed top-4 right-4 z-50"
    >
      {mounted && resolvedTheme === "dark" ? <Sun /> : <Moon />}
    </Button>
  )
}

