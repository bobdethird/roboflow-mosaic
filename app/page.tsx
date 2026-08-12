import { redirect } from "next/navigation"

// The dataset mosaic is the only page now, but it keeps its own path so the
// URL stays stable; the root just points at it.
export default function HomePage() {
  redirect("/roboflow")
}
