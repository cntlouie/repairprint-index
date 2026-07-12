import Link from "next/link";
import type { CatalogPartSummary } from "@/lib/catalog-types";
import { StatusBadge } from "./StatusBadge";

export function PartCard({ part }: { part: CatalogPartSummary }) {
  return (
    <article className="part-card">
      <div className="part-card-topline">
        <span className="eyebrow">{part.componentName}</span>
        <StatusBadge status={part.fitmentStatus} />
      </div>
      <h3><Link href={`/parts/${part.slug}`}>{part.name}</Link></h3>
      <p>{part.designTitle} · revision {part.revision}</p>
      <dl className="mini-facts">
        <div><dt>Material</dt><dd>{part.material ?? "Not recorded"}</dd></div>
        <div><dt>Creator</dt><dd>{part.creator}</dd></div>
        <div><dt>Source</dt><dd>{part.platform}</dd></div>
        <div><dt>Safety</dt><dd>{part.safetyClass === "low" ? "Low-risk screen" : part.safetyClass}</dd></div>
      </dl>
      <Link className="text-link" href={`/parts/${part.slug}`}>View evidence and print notes →</Link>
    </article>
  );
}
