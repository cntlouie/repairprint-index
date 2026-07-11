import type { Metadata } from "next";
import Link from "next/link";
import { SearchBox } from "@/components/SearchBox";
import { searchCatalog } from "@/lib/catalog";

export const metadata: Metadata = {
  title: "Search",
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const results = searchCatalog(q);

  return (
    <div className="shell page-shell">
      <span className="eyebrow">Fitment search</span>
      <h1>Find an exact repair match</h1>
      <p className="lede narrow">Enter the label model number, OEM part number, or the name of the broken component.</p>
      <SearchBox defaultValue={q} compact />

      {q.length >= 2 ? (
        <section className="results" aria-live="polite">
          <div className="results-heading"><h2>{results.length} result{results.length === 1 ? "" : "s"}</h2><span>for “{q}”</span></div>
          {results.length > 0 ? (
            <div className="result-list">
              {results.map((result) => (
                <Link className="result-row" href={result.href} key={`${result.type}-${result.href}`}>
                  <span className="result-type">{result.type}</span>
                  <span><strong>{result.title}</strong><small>{result.subtitle}</small></span>
                  <span className="match-reason">{result.matchReason}</span>
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <h2>No exact match yet</h2>
              <p>Do not guess a similar model. Send the exact label information and the research queue can check it.</p>
              <Link className="button-primary" href="/request-part">Request this part</Link>
            </div>
          )}
        </section>
      ) : (
        <div className="info-panel"><strong>Good inputs:</strong> DV-100, DM-004217, dust-bin latch.</div>
      )}
    </div>
  );
}
