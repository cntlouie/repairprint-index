import type { Metadata } from "next";
import { PolicyStatus } from "@/components/PolicyStatus";
import { trustPageMetadata } from "@/lib/trust-metadata";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/independence", "Editorial independence", "RepairPrint is independent, not manufacturer-endorsed, and never ranks compatibility by commercial value.");
}

export default function IndependencePage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Editorial independence</span>
      <h1>Independent and not manufacturer-endorsed</h1>
      <p className="lede narrow">RepairPrint Index is independent and is not affiliated with or endorsed by the product manufacturers, brands, repositories, or creators listed in the catalogue.</p>
      <PolicyStatus scope="independence and commercial-influence statement" />

      <h2>Why names appear</h2>
      <p>Brand and model names are used in plain text only to identify the exact product for a compatibility claim. Their appearance does not imply sponsorship, approval, certification, OEM equivalence, or a commercial relationship.</p>

      <h2>Ranking remains evidence-led</h2>
      <p>Fitment confidence, safety screening, publication eligibility, and search rank are determined by the documented evidence and rulesets. Affiliate value, advertising, sponsorship, or creator status cannot promote a weaker compatibility claim.</p>

      <h2>Original creators remain primary</h2>
      <p>The original creator landing page is the primary outbound action. RepairPrint does not take ownership of design files and does not mirror them in v0.</p>

      <h2>Prelaunch review</h2>
      <p>Final trademark, disclosure, consumer-law, and independence wording still requires qualified Iceland/EU counsel review. This operating statement is not a claim that review has occurred.</p>
    </div>
  );
}
