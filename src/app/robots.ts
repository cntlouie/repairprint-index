import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  if (process.env.DEMO_MODE !== "false") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/search", "/api/", "/admin/", "/request-part", "/confirm-fit", "/submit-design"] },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
