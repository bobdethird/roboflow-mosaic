import Link from "next/link"
import { headers } from "next/headers"

import { AdminLoginForm } from "@/components/admin-login-form"
import { SiteCredit } from "@/components/site-credit"
import { isAdminContext } from "@/lib/mosaic-admin"

// Admin unlock page. Enter the admin password to set the admin cookie, which
// reveals "Publish & share" on the mosaic pages. Localhost is already admin, so
// this is really for the deployed site.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
}

export default async function AdminPage() {
  const h = await headers()
  const isAdmin = await isAdminContext(h.get("host"), h.get("cookie"))

  return (
    <main className="relative mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-6 px-4 py-12 font-sans">
      <header className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "You’re signed in as admin."
            : "Sign in to publish shareable mosaics."}
        </p>
      </header>

      {isAdmin ? (
        <Link
          href="/knicks-mosaic"
          className="font-medium text-foreground underline"
        >
          Go to the mosaic generator →
        </Link>
      ) : (
        <AdminLoginForm />
      )}

      <SiteCredit className="absolute inset-x-0 bottom-6 text-center" />
    </main>
  )
}
