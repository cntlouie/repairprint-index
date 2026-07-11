import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DemoNotice } from "@/components/DemoNotice";
import { StatusBadge } from "@/components/StatusBadge";
import { getModelsForPart, getPart } from "@/lib/catalog";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const part = getPart(slug);
  if (!part) return {};
  return {
    title: `${part.name} printable replacement`,
    description: part.description,
    robots: part.isDemo || part.fitmentStatus === "candidate_match" || part.fitmentStatus === "disputed"
      ? { index: false, follow: false }
      : undefined,
  };
}

export default async function PartPage({ params }: { params: Params }) {
  const { slug } = await params;
  if (process.env.DEMO_MODE === "false" && process.env.DATABASE_URL) {
    const { findArchivedRedirect } = await import("@/db/redirects");
    const replacement = await findArchivedRedirect(`/parts/${slug}`);
    if (replacement) redirect(replacement as Route);
  }
  const part = getPart(slug);
  if (!part) notFound();
  const models = getModelsForPart(part);

  return (
    <div className="shell page-shell">
      {part.isDemo ? <DemoNotice /> : null}
      <nav className="breadcrumbs" aria-label="Breadcrumb"><span>Parts</span><span>/</span><strong>{part.name}</strong></nav>
      <div className="part-hero">
        <div>
          <div className="badge-row"><StatusBadge status={part.fitmentStatus} /><span className="badge badge-safety">Low-risk screen</span></div>
          <h1>{part.name}</h1>
          <p className="lede narrow">{part.description}</p>
          <div className="compatibility-callout"><strong>Compatible models in this record</strong>{models.map((model) => <Link key={model.id} href={`/brands/${model.brandSlug}/${model.modelSlug}`}>{model.brandName} {model.modelName}</Link>)}</div>
        </div>
        <aside className="source-card">
          <span className="eyebrow">Original design</span>
          <h2>{part.design.title}</h2>
          <dl>
            <div><dt>Creator</dt><dd>{part.design.creator}</dd></div>
            <div><dt>Revision</dt><dd>{part.design.revision}</dd></div>
            <div><dt>Licence</dt><dd>{part.design.licenseCode}</dd></div>
            <div><dt>Last checked</dt><dd>{part.design.lastCheckedAt}</dd></div>
          </dl>
          <a className="button-primary" href={part.design.sourceUrl} rel="noopener noreferrer">Open original source ↗</a>
          <small>RepairPrint links to the creator’s source. It does not host this design file.</small>
        </aside>
      </div>

      <div className="detail-grid">
        <section className="detail-card">
          <span className="eyebrow">Why this label</span><h2>Fitment evidence</h2>
          <div className="evidence-list">
            {part.evidence.map((item) => (
              <article key={item.id}><span>{item.kind.replaceAll("_", " ")}</span><strong>{item.summary}</strong><small>Observed {item.observedAt} · exact model {item.exactModel ? "yes" : "no"} · exact revision {item.exactDesignRevision ? "yes" : "no"}</small></article>
            ))}
          </div>
          <Link className="text-link" href={`/confirm-fit?part=${part.slug}`}>Printed it? Report whether it fits →</Link>
        </section>

        <section className="detail-card">
          <span className="eyebrow">Sourced recipe</span><h2>Print notes</h2>
          <dl className="spec-list">
            <div><dt>Material</dt><dd>{part.printRecipe.material}</dd></div>
            <div><dt>Orientation</dt><dd>{part.printRecipe.orientation}</dd></div>
            <div><dt>Layer height</dt><dd>{part.printRecipe.layerHeight}</dd></div>
            <div><dt>Walls</dt><dd>{part.printRecipe.walls}</dd></div>
            <div><dt>Infill</dt><dd>{part.printRecipe.infill}</dd></div>
            <div><dt>Supports</dt><dd>{part.printRecipe.supports}</dd></div>
            <div><dt>Extra hardware</dt><dd>{part.printRecipe.extraHardware}</dd></div>
          </dl>
          <small>Provenance: {part.printRecipe.provenance.replaceAll("_", " ")}. Settings are not a safety guarantee.</small>
        </section>
      </div>

      <section className="safety-panel"><div><span aria-hidden="true">!</span></div><div><strong>Fit is separate from safety.</strong><p>{part.safetyNotice} Inspect every print before use; layer adhesion, material, printer calibration and wear can change performance.</p></div></section>
    </div>
  );
}
