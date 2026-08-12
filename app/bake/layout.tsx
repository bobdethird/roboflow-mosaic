import { headers } from "next/headers"
import { notFound } from "next/navigation"

import { isLocalhostHost } from "@/lib/localhost-only"

export default async function BakeLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const headerList = await headers()

  if (!isLocalhostHost(headerList.get("host"))) {
    notFound()
  }

  return children
}
