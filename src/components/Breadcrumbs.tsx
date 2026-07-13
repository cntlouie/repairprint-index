import {
  buildBreadcrumbListStructuredData,
  normalizeBreadcrumbItems,
  type BreadcrumbItem,
} from "@/domain/seo";

import { JsonLd } from "./JsonLd";

export function Breadcrumbs({
  items,
  includeJsonLd = true,
}: Readonly<{
  items: readonly BreadcrumbItem[];
  includeJsonLd?: boolean;
}>) {
  const normalized = normalizeBreadcrumbItems(items);

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol className="breadcrumb-list">
          {normalized.map((item, index) => {
            const current = index === normalized.length - 1;
            return (
              <li key={item.url}>
                {current
                  ? <span aria-current="page">{item.name}</span>
                  : <a href={item.url}>{item.name}</a>}
              </li>
            );
          })}
        </ol>
      </nav>
      {includeJsonLd ? <JsonLd data={buildBreadcrumbListStructuredData(normalized)} /> : null}
    </>
  );
}
