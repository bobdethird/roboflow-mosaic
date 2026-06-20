import Link from "next/link"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { NewYorkMosaic } from "@/components/newyork-mosaic"
import { ThemeToggle } from "@/components/theme-toggle"

const FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSfPRaVa9D3Ex0U6sF0G1VUckbJd41X1-8inZ_0oknivex9gRw/viewform"

export default function Page() {
  return (
    <main
      className="flex min-h-svh flex-col items-center gap-6 px-2 pt-10 pb-16 sm:pt-12"
      style={{ fontFamily: "var(--font-mean-hand)" }}
    >
      <ThemeToggle />

      <div className="flex w-full max-w-3xl flex-col gap-4">
        <Button
          variant="link"
          asChild
          className="h-auto self-start p-0 font-sans font-normal underline"
        >
          <Link href="/">
            <ArrowLeft />
            back to home
          </Link>
        </Button>

        <h1 className="text-center text-4xl leading-none font-light tracking-tight text-balance sm:text-6xl md:text-left md:text-7xl">
          A MOSAIC OF NEW YORK
        </h1>

        <p className="font-sans text-sm leading-relaxed text-pretty text-center text-foreground sm:text-base md:text-left">
          The whole is greater than the sum of its parts. Exhibited not only in the Knicks, New York
          is a beautiful reflection of this theme. Our next goal is to build a beautiful 
          mosaic of New York, but this time, built from each of you - the many who have lived and
          made this city what it is. 
        </p>

        <NewYorkMosaic />

        <Button
          asChild
          className="mt-1 h-10 self-center rounded-none border-0 px-5 text-sm"
        >
          <a href={FORM_URL} target="_blank" rel="noopener noreferrer">
            upload your photos
            <ArrowRight />
          </a>
        </Button>
      </div>
    </main>
  )
}
