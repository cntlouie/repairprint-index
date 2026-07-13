import type { Metadata } from "next";

import { currentSeoPage, seoMetadata } from "./seo";

export function trustPageMetadata(path: string, title: string, description: string): Metadata {
  return { title, description, ...seoMetadata(currentSeoPage(path)) };
}
