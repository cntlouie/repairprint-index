import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PartCard } from "@/components/PartCard";
import { getModel, getPartsForModel } from "@/lib/catalog";

type Params = Promise<{ brandSlug: string; modelSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { brandSlug, modelSlug } = await params;
  const model = await getModel(brandSlug, modelSlug);
  if (!model) return {};
  return {
    title: `${model.brandName} ${model.modelName} printable repair parts`,
    description: `Published, evidence-backed printable repair parts for the exact ${model.brandName} ${model.modelName} model.`,
    alternates: { canonical: `/brands/${model.brandSlug}/${model.modelSlug}` },
  };
}

export default async function ModelPage({ params }: { params: Params }) {
  const { brandSlug, modelSlug } = await params;
  const model = await getModel(brandSlug, modelSlug);
  if (!model) notFound();
  const parts = await getPartsForModel(model);

  return (
    <div className="shell page-shell">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <span>{model.categoryName}</span><span>/</span><span>{model.brandName}</span><span>/</span><strong>{model.modelName}</strong>
      </nav>
      <div className="model-header">
        <div>
          <span className="eyebrow">Exact product model</span>
          <h1>{model.brandName} {model.modelName}</h1>
          <p className="lede narrow">
            Solutions on this page are restricted to this exact model. Market, suffix and serial distinctions are not merged.
          </p>
        </div>
        <dl className="fact-card">
          <div><dt>Model identifiers</dt><dd>{model.identifiers.map((identifier) => identifier.displayValue).join(" · ")}</dd></div>
          <div><dt>Market codes</dt><dd>{model.marketCodes.length > 0 ? model.marketCodes.join(" · ") : "Not specified"}</dd></div>
          <div><dt>Label location</dt><dd>{model.labelLocation ?? "Consult the product label or manual"}</dd></div>
          <div><dt>Published solutions</dt><dd>{parts.length}</dd></div>
          <div><dt>Last material update</dt><dd>{formatDate(model.updatedAt)}</dd></div>
        </dl>
      </div>

      {model.identifiers.some((identifier) => identifier.citation) ? (
        <section className="detail-card compact-section" aria-labelledby="identifier-sources-heading">
          <span className="eyebrow">Identifier provenance</span>
          <h2 id="identifier-sources-heading">Sources for model labels</h2>
          <div className="evidence-list">
            {model.identifiers.filter((identifier) => identifier.citation).map((identifier) => (
              <article key={`${identifier.identifierType}:${identifier.displayValue}`}>
                <span>{identifier.identifierType.replaceAll("_", " ")}</span>
                <strong>{identifier.displayValue}</strong>
                <small>
                  {identifier.citation!.sourceTitle} · checked {formatDate(identifier.citation!.lastCheckedAt)}
                </small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="section compact-section">
        <div className="section-heading">
          <div><span className="eyebrow">Printable solutions</span><h2>Parts indexed for this exact model</h2></div>
          <Link className="text-link" href="/methodology">How fitment labels work →</Link>
        </div>
        <div className="card-grid">{parts.map((part) => <PartCard key={part.id} part={part} />)}</div>
      </section>

      <section className="request-banner">
        <div><span className="eyebrow">Part still missing?</span><h2>Request research for this exact model.</h2></div>
        <Link className="button-secondary" href="/request-part">Request a missing part</Link>
      </section>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}
