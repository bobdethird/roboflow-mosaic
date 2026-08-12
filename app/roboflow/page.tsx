import { RoboflowMosaic } from "@/components/roboflow-mosaic"

export const metadata = {
  title: "Roboflow dataset mosaic",
  description:
    "Turn any Roboflow Universe dataset into a photo mosaic of its own median image.",
}

export default function RoboflowMosaicPage() {
  return <RoboflowMosaic />
}
