import type { MetadataRoute } from "next";
import { listModels, listRecentParts } from "@/lib/catalog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (process.env.DEMO_MODE !== "false") return [];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const [models, parts] = await Promise.all([listModels(100), listRecentParts(250)]);
  return [
    { url: siteUrl, changeFrequency: "weekly", priority: 1 },
    ...models.map((model) => ({ url: `${siteUrl}/brands/${model.brandSlug}/${model.modelSlug}`, lastModified: model.updatedAt, changeFrequency: "weekly" as const, priority: 0.8 })),
    ...parts
      .map((part) => ({ url: `${siteUrl}/parts/${part.slug}`, lastModified: part.updatedAt, changeFrequency: "monthly" as const, priority: 0.8 })),
    { url: `${siteUrl}/methodology`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteUrl}/safety`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteUrl}/licensing`, changeFrequency: "monthly", priority: 0.5 },
  ];
}
