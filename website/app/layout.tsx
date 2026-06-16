import { Geist, Geist_Mono } from "next/font/google"
import localFont from "next/font/local"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

// MEAN HAND — handwriting typeface averaged from the EMNIST dataset. All nine
// weights are loaded; its glyph set is only A–Z, a–z, 0–9, so everything else
// (punctuation, spaces) renders via the fallback stack below.
const meanHand = localFont({
  variable: "--font-mean-hand",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
  src: [
    { path: "./fonts/mean-hand/mean_hand_100_thin.woff2", weight: "100", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_200_extralight.woff2", weight: "200", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_300_light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_400_regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_500_medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_600_semibold.woff2", weight: "600", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_700_bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_800_extrabold.woff2", weight: "800", style: "normal" },
    { path: "./fonts/mean-hand/mean_hand_900_black.woff2", weight: "900", style: "normal" },
  ],
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable, meanHand.variable)}
    >
      <body>
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
