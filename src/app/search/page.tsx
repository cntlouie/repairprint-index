import type { Metadata } from "next";
import Link from "next/link";
import { AnalyticsLink, AnalyticsPageEvent } from "@/components/AnalyticsEvents";
import { SearchBox } from "@/components/SearchBox";
import { classifySearchForAnalytics } from "@/domain/analytics";
import { searchCatalogPage } from "@/lib/search";
import { currentSeoPage, seoMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return { title: "Search", ...seoMetadata(currentSeoPage("/search", { hasQueryParameters: true })) };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const page = await searchCatalogPage(q, { limit: 50 });
  const results = page.results;
  const analytics = classifySearchForAnalytics(q);

  return (
    <div className="shell page-shell">
      <span className="eyebrow">Fitment search</span>
      <h1>Find an exact repair match</h1>
      <p className="lede narrow">Enter the label model number, OEM part number, or the name of the broken component.</p>
      <SearchBox defaultValue={q} compact />

      {q.length >= 2 ? (
        <section className="results" aria-labelledby="search-results-heading" aria-live="polite">
          <AnalyticsPageEvent event={{ name: "search_submitted", properties: {
            normalizedCategory: analytics.normalizedCategory,
            queryLength: analytics.queryLength,
            identifierLike: analytics.identifierLike,
          } }} />
          {page.ambiguity ? <AnalyticsPageEvent event={{ name: "variant_disambiguation_shown", properties: { candidateCount: Math.min(page.ambiguity.candidateIds.length, 50) } }} /> : null}
          {results.length === 0 ? <AnalyticsPageEvent event={{ name: "zero_result", properties: { tokenClass: analytics.tokenClass } }} /> : null}
          <div className="results-heading"><h2 id="search-results-heading">{results.length} result{results.length === 1 ? "" : "s"}</h2><span>for “{q}”</span></div>
          {page.ambiguity && <div className="info-panel" role="status"><strong>Choose the exact variant.</strong> Similar formatting resolves to more than one published record, so RepairPrint will not guess or preselect a model.</div>}
          {results.length > 0 ? (
            <div className="result-list">
              {results.map((result, index) => (
                <AnalyticsLink
                  className="result-row"
                  events={[
                    { name: "search_resolved", properties: { entityType: result.entityType, matchClass: result.matchKind, rank: index + 1, ambiguityCount: page.ambiguity?.candidateIds.length ?? 0 } },
                    ...(page.ambiguity ? [{ name: "variant_selected" as const, properties: { selectedRank: index + 1 } }] : []),
                  ]}
                  href={result.href}
                  key={`${result.entityType}-${result.href}`}
                >
                  <span className="result-type">{result.entityType}</span>
                  <span><strong>{result.title}</strong><small>{result.subtitle}</small></span>
                  <span className="match-reason">{result.matchReason}</span>
                  <span aria-hidden="true">→</span>
                </AnalyticsLink>
              ))}
            </div>
          ) : (
            <div className="empty-state" role="status">
              <h2>No exact match yet</h2>
              <p>Do not guess a similar model. Send the exact label information and the research queue can check it.</p>
              <Link className="button-primary" href="/request-part">Request this part</Link>
            </div>
          )}
        </section>
      ) : (
        <div className="info-panel"><strong>Good inputs:</strong> an exact label identifier, an OEM part number, or a component such as “dust-bin latch”.</div>
      )}
    </div>
  );
}
