import type { Metadata } from "next";
import Link from "next/link";

import { PolicyStatus } from "@/components/PolicyStatus";
import { trustPageMetadata } from "@/lib/trust-metadata";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/licensing", "Licensing and attribution", "How RepairPrint preserves creator attribution, licence evidence, original links, and rights holds.");
}

export default function LicensingPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Attribution and rights</span>
      <h1>Original files stay with their creators</h1>
      <p className="lede narrow">RepairPrint stores independently reviewed factual metadata and links to original repository landing pages. It does not host, mirror, proxy, convert, or serve downloadable design files or repository images in v0.</p>
      <PolicyStatus scope="licensing and attribution policy" />

      <h2>What every public design shows</h2>
      <p>Each indexed design identifies the creator, original platform and landing page, observed licence state, attribution wording, revision, retrieval date, rights-check date, and source-check date. A file licence does not automatically grant rights to a photograph, description, diagram, or other media.</p>

      <h2>Licence state is evidence, not a new grant</h2>
      <p><strong>NOT-STATED</strong> means the reviewer did not find an explicit licence. It is not permission to copy, modify, sell, rehost, or otherwise reuse the design. Custom, all-rights-reserved, unknown, and noncommercial terms remain link-only unless separately documented permission says otherwise.</p>

      <h2>Source changes and rights notices</h2>
      <p>A removed, restricted, materially redirected, or changed source moves dependent records to review. Old fit evidence never transfers automatically to a new revision. A credible creator or rightsholder notice places the record on hold while source, authorship, licence, and original-upload evidence are checked.</p>

      <h2>Prelaunch legal status</h2>
      <p>This is an engineering operating draft, not legal advice or a claim of counsel approval. Iceland/EU service classification, contributor terms, privacy wording, notice procedure, and rights presentation still require qualified review. See the <Link href="/notice">notice and takedown process</Link> and <Link href="/independence">independence statement</Link>.</p>
    </div>
  );
}
