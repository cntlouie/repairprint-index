import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { AnalyticsExternalLink, AnalyticsLink, AnalyticsPageEvent } from "@/components/AnalyticsEvents";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { JsonLd } from "@/components/JsonLd";
import { StatusBadge } from "@/components/StatusBadge";
import { buildCreativeWorkStructuredData } from "@/domain/seo";
import { getPart } from "@/lib/catalog";
import { partCatalogueSeoFacts } from "@/lib/catalog-seo";
import type { CatalogFitment, CatalogPrintRecipe, PublicCitation, UnavailableCatalogPart } from "@/lib/catalog-types";
import { currentSeoPage, currentSeoRuntime, seoMetadata } from "@/lib/seo";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const lookup = await getPart(slug);
  if (lookup.kind === "published") {
    const path = `/parts/${lookup.part.canonicalSlug}`;
    const decision = currentSeoPage(path, { catalogue: partCatalogueSeoFacts(lookup.part) });
    return {
      title: `${lookup.part.name} printable replacement`,
      description: `${lookup.part.design.title}: published exact-model fitment evidence, source, licence, print and safety provenance.`,
      ...seoMetadata(decision),
    };
  }
  if (lookup.kind === "unavailable") {
    return {
      title: `${lookup.part.name} source unavailable`,
      ...seoMetadata(currentSeoPage(`/parts/${slug}`)),
    };
  }
  return { ...seoMetadata(currentSeoPage(`/parts/${slug}`)) };
}

export default async function PartPage({ params }: { params: Params }) {
  const { slug } = await params;
  const lookup = await getPart(slug);
  if (lookup.kind === "redirect") permanentRedirect(lookup.location as Route);
  if (lookup.kind === "not_found") notFound();
  if (lookup.kind === "unavailable") return <UnavailablePartPage part={lookup.part} />;

  const { part } = lookup;
  const path = `/parts/${part.canonicalSlug}`;
  const seo = currentSeoPage(path, { catalogue: partCatalogueSeoFacts(part) });
  const origin = currentSeoRuntime().origin;
  const canonicalFitment = part.fitments.find((fitment) => fitment.slug === part.canonicalSlug) ?? part.fitments[0];
  const firstModel = canonicalFitment?.model;
  const breadcrumbs = origin ? [
    { name: "Home", url: `${origin}/` },
    ...(firstModel ? [{ name: `${firstModel.brandName} ${firstModel.modelName}`, url: `${origin}/brands/${firstModel.brandSlug}/${firstModel.modelSlug}` }] : []),
    { name: part.name, url: `${origin}${path}` },
  ] : null;
  return (
    <div className="shell page-shell">
      {canonicalFitment ? <AnalyticsPageEvent event={{
        name: "part_viewed",
        properties: {
          publicId: canonicalFitment.publicId,
          confidenceTier: canonicalFitment.status,
          safetyClass: "low",
        },
      }} /> : null}
      {breadcrumbs ? <Breadcrumbs items={breadcrumbs} includeJsonLd={seo.index} /> : (
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-current="page">{part.name}</span></nav>
      )}
      {seo.index && seo.canonicalUrl ? (
        <JsonLd data={buildCreativeWorkStructuredData({
          name: part.design.title,
          url: seo.canonicalUrl,
          identifier: part.design.publicId,
          creator: part.design.creator,
          dateModified: part.updatedAt,
          about: part.name,
        })} />
      ) : null}
      <div className="part-hero">
        <div>
          <span className="eyebrow">Canonical repair part</span>
          <h1>{part.name}</h1>
          <p className="lede narrow">
            {part.design.title} by {part.design.creator}. Each exact model and source revision keeps its own fitment label and evidence below.
          </p>
          {part.commonNames.length > 0 && part.commonNameCitation ? (
            <div className="provenance-fact">
              <p><strong>Also called:</strong> {part.commonNames.join(" · ")}</p>
              <CitationSources citations={[part.commonNameCitation]} label="Alias source" />
            </div>
          ) : null}
          {part.oemParts.length > 0 ? (
            <div className="compatibility-callout">
              <strong>Published OEM references</strong>
              {part.oemParts.map((oem) => (
                <div className="provenance-fact" key={oem.publicId}>
                  <span>{oem.partNumber} · {oem.name}</span>
                  <CitationSources citations={oem.citations} label="OEM source" />
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <aside className="source-card">
          <span className="eyebrow">Creator record</span>
          <h2>{part.design.creator}</h2>
          <dl>
            <div><dt>Public design ID</dt><dd>{part.design.publicId}</dd></div>
            <div><dt>Platform</dt><dd>{part.design.creatorPlatform}</dd></div>
            <div><dt>Published fitment edges</dt><dd>{part.fitments.length}</dd></div>
            <div><dt>Last material update</dt><dd><time dateTime={part.updatedAt}>{formatDate(part.updatedAt)}</time></dd></div>
          </dl>
          <small>RepairPrint does not host or mirror the design file. Source links below lead to the original landing page.</small>
        </aside>
      </div>

      <section className="section compact-section" aria-labelledby="fitments-heading">
        <div className="section-heading">
          <div><span className="eyebrow">Exact edges</span><h2 id="fitments-heading">Model × design-revision fitments</h2></div>
        </div>
        <div className="fitment-stack">
          {part.fitments.map((fitment) => <FitmentDetails key={fitment.id} fitment={fitment} />)}
        </div>
      </section>
    </div>
  );
}

function FitmentDetails({ fitment }: { fitment: CatalogFitment }) {
  return (
    <article className="detail-card fitment-detail">
      <div className="section-heading">
        <div>
          <div className="badge-row"><StatusBadge status={fitment.status} /><span className="badge badge-safety">Low-risk screen</span></div>
          <h3>
            <Link href={`/brands/${fitment.model.brandSlug}/${fitment.model.modelSlug}`}>
              {fitment.model.brandName} {fitment.model.modelName}
            </Link>
            {" · revision "}{fitment.revision.label}
          </h3>
          <small>Public fitment ID: {fitment.publicId} · published <time dateTime={fitment.publishedAt}>{formatDate(fitment.publishedAt)}</time></small>
          {fitment.model.serialFrom || fitment.model.serialTo ? (
            <small>Serial applicability: {fitment.model.serialFrom ?? "start"}–{fitment.model.serialTo ?? "end"}</small>
          ) : null}
        </div>
      </div>

      <div className="detail-grid">
        <section>
          <span className="eyebrow">Why this label</span><h4>Accepted evidence</h4>
          <div className="evidence-list">
            {fitment.evidence.map((item) => (
              <article key={item.id}>
                <span>{item.kind.replaceAll("_", " ")}</span>
                <strong>{item.summary}</strong>
                <small>
                  Observed {formatDate(item.observedAt)} · exact model {item.exactModel ? "yes" : "no"} · exact revision {item.exactDesignRevision ? "yes" : "no"}
                </small>
                {item.modificationNotes ? <small>Modification: {item.modificationNotes}</small> : null}
                {item.citation ? (
                  <small>
                    Provenance: {item.citation.sourceTitle} · checked {formatDate(item.citation.lastCheckedAt)}
                    {item.citation.locator ? ` · ${item.citation.locator}` : ""}
                  </small>
                ) : <small>Provenance: reviewed evidence record attached to this exact fitment edge.</small>}
              </article>
            ))}
          </div>
          <AnalyticsLink
            className="text-link"
            events={[{ name: "fit_report_started", properties: { publicId: fitment.publicId } }]}
            href={`/confirm-fit?part=${fitment.slug}`}
          >
            Printed it? Report whether it fits →
          </AnalyticsLink>
        </section>

        <section>
          <span className="eyebrow">Original source and rights</span><h4>{fitment.source.title}</h4>
          <dl className="spec-list">
            <div><dt>Creator</dt><dd>{fitment.revision.attributionText}</dd></div>
            <div><dt>Revision</dt><dd>{fitment.revision.label}</dd></div>
            <div><dt>Licence state</dt><dd>{fitment.revision.licenseCode}{fitment.revision.licenseVersion ? ` ${fitment.revision.licenseVersion}` : ""}</dd></div>
            <div><dt>Rights checked</dt><dd>{formatDate(fitment.revision.rightsCheckedAt)}</dd></div>
            <div><dt>Retrieved</dt><dd>{formatDate(fitment.source.retrievedAt)}</dd></div>
            <div><dt>Source checked</dt><dd>{formatDate(fitment.source.lastCheckedAt)}</dd></div>
          </dl>
          <AnalyticsExternalLink
            className="button-primary"
            event={{
              name: "original_source_clicked",
              properties: {
                publicId: fitment.publicId,
                sourcePlatform: fitment.source.platform,
                confidenceTier: fitment.status,
              },
            }}
            href={fitment.source.url}
          >
            Open original source ↗
          </AnalyticsExternalLink>
        </section>
      </div>

      <div className="detail-grid">
        <RecipeDetails recipe={fitment.printRecipe} />
        <section>
          <span className="eyebrow">Independent safety review</span><h4>Low-risk v0 boundary</h4>
          <p><strong>Failure consequence:</strong> {fitment.safety.failureConsequence}</p>
          <p>{fitment.safety.rationale}</p>
          <small>
            Safety ruleset {fitment.safety.rulesetVersion} · reviewed {formatDate(fitment.safety.reviewedAt)}. Fitment is not a safety guarantee.
          </small>
        </section>
      </div>
    </article>
  );
}

function RecipeDetails({ recipe }: { recipe: CatalogPrintRecipe | null }) {
  if (!recipe) {
    return (
      <section>
        <span className="eyebrow">Print recipe provenance</span><h4>No reviewed recipe recorded</h4>
        <p>Consult the original creator page. RepairPrint does not infer missing settings.</p>
      </section>
    );
  }
  return (
    <section>
      <span className="eyebrow">Print recipe provenance</span><h4>Reviewed print notes</h4>
      <dl className="spec-list">
        <div><dt>Material</dt><dd>{recipe.material}</dd></div>
        <div><dt>Nozzle</dt><dd>{recipe.nozzleMm === null ? "Not recorded" : `${recipe.nozzleMm} mm`}</dd></div>
        <div><dt>Layer height</dt><dd>{recipe.layerHeightMm === null ? "Not recorded" : `${recipe.layerHeightMm} mm`}</dd></div>
        <div><dt>Walls</dt><dd>{recipe.wallCount ?? "Not recorded"}</dd></div>
        <div><dt>Infill</dt><dd>{recipe.infillPercent === null ? "Not recorded" : `${recipe.infillPercent}%`}</dd></div>
        <div><dt>Supports</dt><dd>{recipe.supports ?? "Not recorded"}</dd></div>
        <div><dt>Orientation</dt><dd>{recipe.orientation ?? "Not recorded"}</dd></div>
      </dl>
      <small>
        Provenance: {recipe.provenance.replaceAll("_", " ")}
        {recipe.citation ? ` · ${recipe.citation.sourceTitle} · checked ${formatDate(recipe.citation.lastCheckedAt)}` : " · no separate recipe citation recorded"}.
        Settings are not a safety guarantee.
      </small>
    </section>
  );
}

function UnavailablePartPage({ part }: { part: UnavailableCatalogPart }) {
  const origin = currentSeoRuntime().origin;
  return (
    <div className="shell page-shell">
      {origin ? <Breadcrumbs items={[{ name: "Home", url: `${origin}/` }, { name: part.name, url: `${origin}/parts/${part.slug}` }]} includeJsonLd={false} /> : (
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-current="page">{part.name}</span></nav>
      )}
      <section className="detail-card">
        <span className="eyebrow">Source unavailable</span>
        <h1>{part.name}</h1>
        <p className="lede narrow">
          RepairPrint previously recorded {part.designTitle} by {part.creator} for {part.modelLabel}, but the original landing page is no longer available.
        </p>
        <p>
          This record is excluded from catalogue listings and recommendations. The last recorded source check was {formatDate(part.sourceLastCheckedAt)}.
        </p>
        <div className="badge-row"><span className="badge badge-disputed">Unavailable</span></div>
        <Link className="button-secondary" href="/request-part">Request an alternative</Link>
      </section>
    </div>
  );
}

function CitationSources({ citations, label }: { citations: readonly PublicCitation[]; label: string }) {
  return (
    <small className="fact-provenance">
      {label}:{" "}
      {citations.map((citation, index) => (
        <span key={`${citation.sourceUrl ?? citation.sourceTitle}:${citation.locator ?? index}`}>
          {index > 0 ? " · " : null}
          {citation.sourceUrl ? (
            <a href={citation.sourceUrl} rel="noreferrer" target="_blank">{citation.sourceTitle}</a>
          ) : citation.sourceTitle}
          {` (checked ${formatDate(citation.lastCheckedAt)})`}
        </span>
      ))}
    </small>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}
