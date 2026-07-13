import type { Metadata } from "next";
import Link from "next/link";

import { PolicyStatus } from "@/components/PolicyStatus";
import { trustPageMetadata } from "@/lib/trust-metadata";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/methodology", "Fitment methodology", "How RepairPrint separates exact-model fit evidence, disputes, safety, and publication authority.");
}

export default function MethodologyPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Trust methodology</span>
      <h1>What each fitment label means</h1>
      <p className="lede narrow">Confidence belongs to one exact design revision and one exact product model. Fit evidence and safety approval are separate decisions.</p>
      <PolicyStatus scope="fitment and evidence method" />

      <h2>Verified fit</h2>
      <p>A trusted, accepted physical test covers the exact design revision and exact product model, with no credible unresolved incompatibility report. The label describes fit only; it is not a safety certification.</p>

      <h2>Community confirmed</h2>
      <p>At least two independent exact-model and exact-revision successes are accepted, including installed-part photo evidence, with no unresolved negative report. Reposts by one actor do not manufacture independence.</p>

      <h2>Creator listed</h2>
      <p>The original designer explicitly names the exact model and revision, but RepairPrint has not independently verified the fit.</p>

      <h2>Candidate, disputed, and rejected records</h2>
      <p>Dimensions, shared OEM numbers, family similarity, or machine suggestions can create a candidate only. Candidates are not published as confirmed fits. One accepted exact-model incompatibility report opens a dispute and removes the edge from recommendations and indexing while a reviewer investigates.</p>

      <h2>Evidence handling</h2>
      <p>Only accepted evidence participates. A fit after modification preserves the modification. A print that fails before fit can be tested is recorded as a print failure, never as an incompatibility. Evidence stays attached to the revision actually tested.</p>

      <h2>Publication boundary</h2>
      <p>A public record also needs a live original source, creator and attribution, a recorded licence state, current rights and safety review, claim provenance, and current rulesets. No public submission publishes automatically.</p>
      <p>Read the separate <Link href="/safety">safety boundary</Link>, <Link href="/corrections">correction process</Link>, and <Link href="/licensing">licensing and attribution policy</Link>.</p>
    </div>
  );
}
