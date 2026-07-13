import type { Metadata } from "next";
import Link from "next/link";

import { PolicyStatus } from "@/components/PolicyStatus";
import { trustPageMetadata } from "@/lib/trust-metadata";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/corrections", "Corrections and disputes", "How exact claims are corrected, disputed, archived, and redirected without erasing evidence history.");
}

export default function CorrectionsPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Corrections and disputes</span>
      <h1>Correct the exact claim, preserve the evidence</h1>
      <p className="lede narrow">RepairPrint archives and redirects records instead of erasing the history needed to understand a compatibility or rights decision.</p>
      <PolicyStatus scope="correction and dispute process" />

      <h2>Wrong-model or incompatibility reports</h2>
      <p>One accepted exact-model and exact-revision incompatibility report opens a dispute. The affected edge is moved to review and removed from search, sitemap, recommendations, and cache while the evidence is classified. Print failure remains separate from fit failure.</p>

      <h2>Source removal or revision change</h2>
      <p>When an original landing page disappears, becomes restricted, materially redirects, or changes, dependent claims move to review. A new design revision receives a new evidence decision; old fit evidence is never transferred silently.</p>

      <h2>Decision record</h2>
      <p>Reviewers preserve the report and relevant page state privately, inspect every related model/design/component edge, record the reason and evidence, recompute deterministic labels, and retain the audit and redirect history. Correction does not merge ambiguous suffixes, regions, revisions, or serial breaks.</p>

      <h2>Reporting</h2>
      <p>Before launch, a configured and monitored notice channel plus named operators must be in place. See <Link href="/notice">notice, takedown, and urgent safety reporting</Link> for the current channel status.</p>
    </div>
  );
}
