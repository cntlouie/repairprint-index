import type { MetadataRoute } from "next";
import { currentSeoRuntime } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const runtime = currentSeoRuntime();
  if (!runtime.indexingAllowed || !runtime.origin) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/search",
          "/api/",
          "/admin",
          "/preview",
          "/designs/",
          "/request-part",
          "/confirm-fit",
          "/submit-design",
          "/contribution-privacy",
        ],
      },
    ],
    sitemap: `${runtime.origin}/sitemap.xml`,
  };
}
