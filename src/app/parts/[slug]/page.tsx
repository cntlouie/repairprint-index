import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { StatusBadge } from "@/components/StatusBadge";
import { getPart } from "@/lib/catalog";
import type { CatalogFitment, CatalogPrintRecipe, UnavailableCatalogPart } from "@/lib/catalog-types";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const lookup = await getPart(slug);
  if (lookup.kind === "published") {
    return {
      title: `${lookup.part.name} printable replacement`,
      description: `${lookup.part.design.title}: published exact-model fitment evidence, source, licence, print and safety provenance.`,
      alternates: { canonical: `/parts/${lookup.part.canonicalSlug}` },
    };
  }
  if (lookup.kind === "unavailable") {
    return {
      title: `${lookup.part.name} source unavailable`,
      robots: { index: false, follow: true },
    };
  }
  return {};
}

export default async function PartPage({ params }: { params: Params }) {
  const { slug } = await params;
  const lookup = await getPart(slug);
  if (lookup.kind === "redirect") permanentRedirect(lookup.location as Route);
  if (lookup.kind === "not_found") notFound();
  if (lookup.kind === "unavailable") return <UnavailablePartPage part={lookup.part} />;

  const { part } = lookup;
  return (
    <div className="shell page-shell">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><span>Parts</span><span>/</span><strong>{part.name}</strong></nav>
      <div className="part-hero">
        <div>
          <span className="eyebrow">Canonical repair part</span>
          <h1>{part.name}</h1>
          <p className="lede narrow">
            {part.design.title} by {part.design.creator}. Each exact model and source revision keeps its own fitment label and evidence below.
          </p>
          {part.commonNames.length > 0 ? <p><strong>Also called:</strong> {part.commonNames.join(" · ")}</p> : null}
          {part.oemParts.length > 0 ? (
            <div className="compatibility-callout">
              <strong>Published OEM references</strong>
              {part.oemParts.map((oem) => <span key={oem.publicId}>{oem.partNumber} · {oem.name}</span>)}
            </div>
          ) : null}
        </div>
        <aside className="source-card">
          <span className="eyebrow">Creator record</span>
          <h2>{part.design.creator}</h2>
          <dl>
            <div><dt>Platform</dt><dd>{part.design.creatorPlatform}</dd></div>
            <div><dt>Published fitment edges</dt><dd>{part.fitments.length}</dd></div>
            <div><dt>Last material update</dt><dd>{formatDate(part.updatedAt)}</dd></div>
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
          <Link className="text-link" href={`/confirm-fit?part=${fitment.slug}`}>Printed it? Report whether it fits →</Link>
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
          <a className="button-primary" href={fitment.source.url} rel="noopener noreferrer">Open original source ↗</a>
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
  return (
    <div className="shell page-shell">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><span>Parts</span><span>/</span><strong>{part.name}</strong></nav>
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}
