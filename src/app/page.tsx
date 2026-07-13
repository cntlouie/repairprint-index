import type { Metadata } from "next";
import Link from "next/link";
import { DemoNotice } from "@/components/DemoNotice";
import { PartCard } from "@/components/PartCard";
import { SearchBox } from "@/components/SearchBox";
import { JsonLd } from "@/components/JsonLd";
import { buildWebSiteStructuredData } from "@/domain/seo";
import { listModels, listRecentParts } from "@/lib/catalog";
import { currentSeoPage, seoMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  const decision = currentSeoPage("/");
  return {
    title: "RepairPrint Index",
    description: "Find evidence-backed 3D-printable replacement parts for the exact product you own.",
    ...seoMetadata(decision),
  };
}

export default async function HomePage() {
  const [models, recentParts] = await Promise.all([listModels(), listRecentParts()]);
  const seo = currentSeoPage("/");

  return (
    <>
      {seo.index && seo.canonicalUrl ? (
        <JsonLd data={buildWebSiteStructuredData({
          name: "RepairPrint Index",
          origin: new URL(seo.canonicalUrl).origin,
        })} />
      ) : null}
      <section className="hero">
        <div className="shell hero-grid">
          <div className="hero-copy">
            <span className="kicker">Repair the product. Keep the machine.</span>
            <h1>Find the tiny part that saves the whole machine.</h1>
            <p className="lede">
              Search the exact model you own. See printable replacements, what they fit, how that fit was verified,
              and where the original designer published the file.
            </p>
            <SearchBox />
            <div className="search-hints">
              <span>Search by:</span>
              <span className="search-hint-pill">model number</span>
              <span className="search-hint-pill">OEM part number</span>
              <span className="search-hint-pill">broken component</span>
            </div>
          </div>
          <div className="hero-visual" aria-label="Exploded-view illustration of a vacuum with a highlighted small replacement clip">
            <div className="machine-shape">
              <div className="machine-handle" />
              <div className="machine-body"><span>EXACT</span><strong>MODEL ID</strong></div>
              <div className="machine-wheel machine-wheel-a" />
              <div className="machine-wheel machine-wheel-b" />
              <div className="highlight-part">small clip</div>
              <div className="guide-line" />
            </div>
            <div className="visual-caption"><span className="verified-dot" /> Exact-model evidence, not vague search matches</div>
          </div>
        </div>
      </section>

      {process.env.DEMO_MODE !== "false" ? <div className="shell"><DemoNotice /></div> : null}

      <section className="trust-strip">
        <div className="shell trust-grid">
          <div><strong>Exact-model fitment</strong><span>Variants stay separate</span></div>
          <div><strong>Evidence you can inspect</strong><span>Claims show their source</span></div>
          <div><strong>Creator-first linking</strong><span>Download from the original</span></div>
          <div><strong>Safety screened</strong><span>Low-risk parts only in v1</span></div>
        </div>
      </section>

      <section className="section shell">
        <div className="section-heading">
          <div><span className="eyebrow">Recently checked</span><h2>Repairs with fitment evidence</h2></div>
          <Link className="text-link" href="/search">Browse the index →</Link>
        </div>
        {recentParts.length > 0 ? (
          <div className="card-grid">{recentParts.map((part) => <PartCard key={part.id} part={part} />)}</div>
        ) : <p>No publication-eligible catalogue records are available yet.</p>}
      </section>

      <section className="section section-muted">
        <div className="shell two-column">
          <div>
            <span className="eyebrow">How it works</span>
            <h2>Compatibility earns its label.</h2>
            <p>RepairPrint does not turn an AI guess or shared model family into a verified fit.</p>
          </div>
          <ol className="steps">
            <li><span>1</span><div><strong>Identify the exact model</strong><p>Model suffixes and regional variants are kept distinct.</p></div></li>
            <li><span>2</span><div><strong>Connect the physical component</strong><p>OEM numbers, aliases and supersessions point to the same real-world part.</p></div></li>
            <li><span>3</span><div><strong>Inspect fitment evidence</strong><p>Trusted tests, community reports and creator claims are different evidence types.</p></div></li>
          </ol>
        </div>
      </section>

      <section className="section shell">
        <div className="section-heading"><div><span className="eyebrow">Published catalogue</span><h2>Supported exact product models</h2></div></div>
        {models.length > 0 ? (
          <div className="model-grid">
            {models.map((model) => (
              <Link className="model-tile" key={model.id} href={`/brands/${model.brandSlug}/${model.modelSlug}`}>
                <span>{model.brandName}</span><strong>{model.modelName}</strong><small>{model.marketCodes.join(" · ") || "Exact model"}</small>
              </Link>
            ))}
          </div>
        ) : <p>Published exact-model pages will appear only after every evidence, rights, source and safety gate passes.</p>}
      </section>

      <section className="section shell request-banner">
        <div><span className="eyebrow">Nothing found?</span><h2>Tell us what broke.</h2><p>Missing-part requests decide what the index researches next.</p></div>
        <Link className="button-secondary" href="/request-part">Request a missing part</Link>
      </section>
    </>
  );
}
