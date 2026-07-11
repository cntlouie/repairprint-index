import Link from "next/link";
import type { CatalogPart } from "@/lib/catalog-types";
import { StatusBadge } from "./StatusBadge";

export function PartCard({ part }: { part: CatalogPart }) {
  return (
    <article className="part-card">
      <div className="part-card-topline">
        <span className="eyebrow">{part.componentName}</span>
        <StatusBadge status={part.fitmentStatus} />
      </div>
      <h3><Link href={`/parts/${part.slug}`}>{part.name}</Link></h3>
      <p>{part.description}</p>
      <dl className="mini-facts">
        <div><dt>Material</dt><dd>{part.printRecipe.material}</dd></div>
        <div><dt>Source</dt><dd>{part.design.platform}</dd></div>
        <div><dt>Safety</dt><dd>{part.safetyClass === "low" ? "Low-risk screen" : part.safetyClass}</dd></div>
      </dl>
      <Link className="text-link" href={`/parts/${part.slug}`}>View evidence and print notes →</Link>
    </article>
  );
}
