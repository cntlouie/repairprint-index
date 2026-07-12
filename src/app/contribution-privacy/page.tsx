import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Private contribution notice",
  robots: { follow: false, index: false },
};

export default function ContributionPrivacyPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Operating draft · WP-08</span>
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
        An email is private and is used only for the contribution, a moderator question, or the match alert you requested. Consent creates a dormant follow-up hook; it does not send an email by itself.
      </p>
      <h2>Links and publication</h2>
      <p>
        Submitted source or evidence links are stored for staff review and are not fetched by the intake service. Moderators must independently verify factual claims, provenance, rights, safety, and exact fitment before any separate publication decision.
      </p>
      <h2>Retention status</h2>
      <p>
        This notice is the versioned engineering operating draft <code>wp08-operating-draft-v1</code>. A final retention period and legal wording still require counsel review before production intake is enabled. Legacy contact data never receives inferred consent.
      </p>
    </div>
  );
}
