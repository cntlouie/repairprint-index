import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/Breadcrumbs";
import { JsonLd } from "@/components/JsonLd";
import { PartCard } from "@/components/PartCard";
import { buildCollectionPageStructuredData } from "@/domain/seo";
import { getModel, getPartsForModel } from "@/lib/catalog";
import { catalogModelMaterialUpdatedAt, modelCatalogueSeoFacts } from "@/lib/catalog-seo";
import { currentSeoPage, currentSeoRuntime, seoMetadata } from "@/lib/seo";

type Params = Promise<{ brandSlug: string; modelSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { brandSlug, modelSlug } = await params;
  const model = await getModel(brandSlug, modelSlug);
  const path = `/brands/${brandSlug}/${modelSlug}`;
  if (!model) return { ...seoMetadata(currentSeoPage(path)) };
  const parts = await getPartsForModel(model);
  const decision = currentSeoPage(path, { catalogue: modelCatalogueSeoFacts(model, parts) });
  return {
    title: `${model.brandName} ${model.modelName} printable repair parts`,
    description: modelDescription(model.brandName, model.modelName),
    ...seoMetadata(decision),
  };
}

export default async function ModelPage({ params }: { params: Params }) {
  const { brandSlug, modelSlug } = await params;
  const model = await getModel(brandSlug, modelSlug);
  if (!model) notFound();
  const parts = await getPartsForModel(model);
  const path = `/brands/${model.brandSlug}/${model.modelSlug}`;
  const seo = currentSeoPage(path, { catalogue: modelCatalogueSeoFacts(model, parts) });
  const materialUpdatedAt = catalogModelMaterialUpdatedAt(model, parts);
  const origin = currentSeoRuntime().origin;
  const breadcrumbs = origin ? [
    { name: "Home", url: `${origin}/` },
    { name: `${model.brandName} ${model.modelName}`, url: `${origin}${path}` },
  ] : null;

  return (
    <div className="shell page-shell">
      {breadcrumbs ? <Breadcrumbs items={breadcrumbs} includeJsonLd={seo.index} /> : (
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-current="page">{model.brandName} {model.modelName}</span></nav>
      )}
      {seo.index && seo.canonicalUrl ? (
        <JsonLd data={buildCollectionPageStructuredData({
          name: `${model.brandName} ${model.modelName}`,
          url: seo.canonicalUrl,
          description: modelDescription(model.brandName, model.modelName),
          dateModified: materialUpdatedAt,
          items: parts.map((part) => ({ name: part.name, url: `${origin!}/parts/${part.slug}` })),
        })} />
      ) : null}
      <div className="model-header">
        <div>
          <span className="eyebrow">Exact product model</span>
          <h1>{model.brandName} {model.modelName}</h1>
          <p className="lede narrow">
            {modelDescription(model.brandName, model.modelName)} Market, suffix, and serial distinctions are not merged.
          </p>
        </div>
        <dl className="fact-card">
          <div><dt>Model identifiers</dt><dd>{model.identifiers.map((identifier) => identifier.displayValue).join(" · ")}</dd></div>
          <div><dt>Market codes</dt><dd>{model.marketCodes.length > 0 ? model.marketCodes.join(" · ") : "Not specified"}</dd></div>
          <div><dt>Label location</dt><dd>{model.labelLocation ?? "Consult the product label or manual"}</dd></div>
          <div><dt>Published solutions</dt><dd>{parts.length}</dd></div>
          <div><dt>Last material update</dt><dd><time dateTime={materialUpdatedAt}>{formatDate(materialUpdatedAt)}</time></dd></div>
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
        {parts.length > 0 ? (
          <div className="card-grid">{parts.map((part) => <PartCard key={part.id} part={part} />)}</div>
        ) : (
          <div className="empty-state" role="status">
            <h3>No publication-eligible repair solution yet</h3>
            <p>This exact model is kept separate, but it remains out of search indexes and the sitemap until a live, evidenced, rights-reviewed, low-risk fitment is published.</p>
          </div>
        )}
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

function modelDescription(brandName: string, modelName: string): string {
  return `Published, evidence-backed printable repair parts for the exact ${brandName} ${modelName} model.`;
}
