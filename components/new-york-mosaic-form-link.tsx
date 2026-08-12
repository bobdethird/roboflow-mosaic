"use client"

import * as React from "react"
import { track } from "@vercel/analytics"

import {
  NEW_YORK_MOSAIC_ANALYTICS_EVENT,
  NEW_YORK_MOSAIC_FORM_URL,
  NEW_YORK_MOSAIC_LEGACY_PATH,
  type NewYorkMosaicFormSource,
} from "@/lib/new-york-mosaic"

type NewYorkMosaicFormLinkProps =
  React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    source: NewYorkMosaicFormSource
  }

export const NewYorkMosaicFormLink =
  React.forwardRef<HTMLAnchorElement, NewYorkMosaicFormLinkProps>(
    (
      {
        source,
        href = NEW_YORK_MOSAIC_FORM_URL,
        target = "_blank",
        rel = "noopener noreferrer",
        onClick,
        ...props
      },
      ref
    ) => {
      function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
        onClick?.(event)

        if (event.defaultPrevented) {
          return
        }

        track(NEW_YORK_MOSAIC_ANALYTICS_EVENT, {
          destination: "google-form",
          legacyPath: NEW_YORK_MOSAIC_LEGACY_PATH,
          source,
        })
      }

      return (
        <a
          ref={ref}
          href={href}
          target={target}
          rel={rel}
          onClick={handleClick}
          {...props}
        />
      )
    }
  )

NewYorkMosaicFormLink.displayName = "NewYorkMosaicFormLink"
