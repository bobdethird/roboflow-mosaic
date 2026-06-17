import Link from "next/link"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"

const FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSdm6zqyMquEWXAcvz8Gr3Q8i4xlYSeOyvq_1uxtcz4bPcPRFg/viewform?usp=dialog"

export default function Page() {
  return (
    <main
      className="flex min-h-svh flex-col items-center gap-9 px-2 pt-10 pb-28 sm:pt-12 sm:pb-32"
      style={{ fontFamily: "var(--font-mean-hand)" }}
    >
      <ThemeToggle />

      <header className="flex w-full max-w-3xl flex-col gap-4">
        <Button variant="link" asChild className="h-auto self-start p-0 font-sans font-normal underline">
          <Link href="/">
            <ArrowLeft />
            back to home
          </Link>
        </Button>

        <h1 className="text-left text-5xl leading-none font-light tracking-tight text-balance sm:text-6xl md:text-7xl">
          A MOSAIC OF NEW YORK
        </h1>

        <p className="max-w-2xl font-sans text-sm leading-relaxed text-pretty text-muted-foreground sm:text-base">
          We want to build a beautiful mosaic of New York. And that can only be done
          with the help of the many who have lived and visited this city. Use the form below to contribute to it. Every photo becomes a tile,
          and together they transform an image into a mosaic no single image could
          capture.
        </p>

        <Button asChild className="mt-2 h-10 self-start rounded-none border-0 px-5 text-sm">
          <a href={FORM_URL} target="_blank" rel="noopener noreferrer">
            upload your photos
            <ArrowRight />
          </a>
        </Button>
      </header>
    </main>
  )
}
