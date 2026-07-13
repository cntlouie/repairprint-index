import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Private contribution notice",
  robots: { follow: false, index: false },
};

export default function ContributionPrivacyPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Operating draft · WP-09</span>
      <h1>Private contribution notice</h1>
      <p>
        Missing-part requests, design links, and fit reports enter a private moderation queue. They never publish automatically.
      </p>
      <h2>What the queue stores</h2>
      <p>
        RepairPrint stores the technical fields you submit, server-recorded consent and verification timestamps, pseudonymous abuse/deduplication digests, and an optional contact email. Anti-spam tokens, honeypot values, raw network addresses, and browser idempotency tokens are not retained.
      </p>
      <h2>How optional contact is used</h2>
      <p>
        An email is private and is used only for the contribution, a moderator question, or the match alert you requested. Consent alone creates no email or delivery row. A later qualifying server event must recheck active, current, unexpired consent before creating follow-up work.
      </p>
      <h2>Links and publication</h2>
      <p>
        Submitted source or evidence links are stored for staff review and are not fetched by the intake service. Moderators must independently verify factual claims, provenance, rights, safety, and exact fitment before any separate publication decision.
      </p>
      <h2>Optional private photos</h2>
      <p>
        Model-label, installed-fit, and broken-part photos are optional and remain private. Ownership or permission, private storage, derivative processing, and any later public display are separate decisions; public display is never inferred. Accepted photos are decoded, orientation-corrected, stripped of metadata, and copied to private review derivatives. AAL2 evidence reviewers may view and manually redact rectangles, with every action audited. RepairPrint does not use automatic face recognition.
      </p>
      <h2>Retention status</h2>
      <p>
        This notice includes the versioned WP-09 engineering operating draft. Production media intake remains disabled until counsel and operations select its terms, privacy notice, retention version, and duration. Cleanup deletes storage objects before database rows; storage failure preserves the record for retry. Legacy data never receives inferred photo or public-display consent.
      </p>
    </div>
  );
}
