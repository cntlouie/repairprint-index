import Link from "next/link";
import { DemoNotice } from "@/components/DemoNotice";
import { PartCard } from "@/components/PartCard";
import { SearchBox } from "@/components/SearchBox";
import { listModels, listRecentParts } from "@/lib/catalog";

export default function HomePage() {
  const models = listModels();
  const recentParts = listRecentParts();

  return (
    <>
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
              <button type="button">model number</button>
              <button type="button">OEM part number</button>
              <button type="button">broken component</button>
            </div>
          </div>
          <div className="hero-visual" aria-label="Exploded-view illustration of a vacuum with a highlighted small replacement clip">
            <div className="machine-shape">
              <div className="machine-handle" />
              <div className="machine-body"><span>MODEL</span><strong>DV-100</strong></div>
              <div className="machine-wheel machine-wheel-a" />
              <div className="machine-wheel machine-wheel-b" />
              <div className="highlight-part">small clip</div>
              <div className="guide-line" />
            </div>
            <div className="visual-caption"><span className="verified-dot" /> Exact-model evidence, not vague search matches</div>
          </div>
        </div>
      </section>

      <div className="shell"><DemoNotice /></div>

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
        <div className="card-grid">
          {recentParts.map((part) => <PartCard key={part.id} part={part} />)}
        </div>
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
        <div className="section-heading"><div><span className="eyebrow">Demo catalogue</span><h2>Supported product models</h2></div></div>
        <div className="model-grid">
          {models.map((model) => (
            <Link className="model-tile" key={model.id} href={`/brands/${model.brandSlug}/${model.modelSlug}`}>
              <span>{model.brandName}</span><strong>{model.modelName}</strong><small>{model.region}</small>
            </Link>
          ))}
        </div>
      </section>

      <section className="section shell request-banner">
        <div><span className="eyebrow">Nothing found?</span><h2>Tell us what broke.</h2><p>Missing-part requests decide what the index researches next.</p></div>
        <Link className="button-secondary" href="/request-part">Request a missing part</Link>
      </section>
    </>
  );
}
