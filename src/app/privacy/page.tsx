import type { Metadata } from "next";
import Link from "next/link";

import { PolicyStatus } from "@/components/PolicyStatus";
import { trustPageMetadata } from "@/lib/trust-metadata";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/privacy", "General privacy", "Public browsing, aggregate analytics, and the separate private contribution workflow.");
}

export default function PrivacyPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">General privacy</span>
      <h1>Use the public index without an account</h1>
      <p className="lede narrow">Public catalogue and search journeys do not require a profile. RepairPrint does not use analytics cookies, browser fingerprints, local-storage identifiers, or cross-site tracking.</p>
      <PolicyStatus scope="general public-site privacy notice" />

      <h2>Public browsing</h2>
      <p>Web hosting necessarily receives a network request to deliver a page. RepairPrint analytics does not read or retain IP addresses, user-agent strings, full referrers, raw searches, or persistent browser identifiers. Production analytics remains disabled unless a reviewed, first-party aggregate configuration is explicitly enabled.</p>

      <h2>Aggregate product signals</h2>
      <p>When enabled, strict server schemas accept only bounded categories, lengths, ranks, counts, and the public catalogue identifiers required by the documented event. Only daily counters are retained; raw event payloads and exact event times are not stored. Analytics never changes compatibility, safety, publication, or ranking.</p>

      <h2>Contributions are separate</h2>
      <p>Missing-part requests, design links, fit reports, and optional photos enter a private moderation workflow with separate consent, access, and retention controls. Read the <Link href="/contribution-privacy">private contribution notice</Link> before submitting. Nothing submitted becomes public automatically.</p>

      <h2>Prelaunch status</h2>
      <p>Final privacy wording, controller/contact details, retention decisions, and Iceland/EU legal review remain launch blockers. No statement on this page claims final counsel or regulatory approval.</p>
    </div>
  );
}
