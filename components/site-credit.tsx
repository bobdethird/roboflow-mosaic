import { cn } from "@/lib/utils"

const BUILDERS = [
  { handle: "cadenbuild", url: "https://x.com/cadenbuild" },
  { handle: "mohul_shukla", url: "https://x.com/mohul_shukla" },
]

// Shared "built by" credit shown at the bottom of every page.
export function SiteCredit({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "font-mono text-xs text-muted-foreground",
        className
      )}
    >
      built by{" "}
      <a
        href={BUILDERS[0].url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        @{BUILDERS[0].handle}
      </a>{" "}
      and{" "}
      <a
        href={BUILDERS[1].url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        @{BUILDERS[1].handle}
      </a>
    </p>
  )
}
