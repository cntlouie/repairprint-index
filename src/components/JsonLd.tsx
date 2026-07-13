import { serializeJsonLd, type SupportedStructuredData } from "@/domain/seo";

export function JsonLd({
  data,
  id,
}: Readonly<{
  data: SupportedStructuredData;
  id?: string;
}>) {
  return (
    <script
      {...(id ? { id } : {})}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
