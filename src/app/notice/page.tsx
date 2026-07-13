import type { Metadata } from "next";
import { PolicyStatus } from "@/components/PolicyStatus";
import { resolveNoticeChannel } from "@/domain/notice-channel";
import { trustPageMetadata } from "@/lib/trust-metadata";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/notice", "Notice, takedown, and urgent safety reporting", "The prelaunch process and configured channel status for rights, correction, and urgent safety notices.");
}

export default function NoticePage() {
  const channel = resolveNoticeChannel(process.env.NOTICE_CONTACT_URL);
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">Notice and urgent safety reporting</span>
      <h1>Rights, illegal-content, correction, and safety notices</h1>
      <p className="lede narrow">Credible rights and high-severity safety notices receive the highest moderation priority. This page does not invent a contact or imply that an unconfigured inbox is monitored.</p>
      <PolicyStatus scope="notice, takedown, and urgent-safety process" />

      {channel.configured ? (
        <p className="success-panel" role="status">
          The deployment has an explicitly configured notice channel. <a href={channel.url} rel="noopener noreferrer">Open the configured notice form</a>.
        </p>
      ) : (
        <p className="error-panel" role="status">
          The production notice channel is not configured. Public launch remains blocked until a monitored channel and named primary and backup operators are configured and tested.
        </p>
      )}

      <h2>What a notice should identify</h2>
      <p>Provide the exact RepairPrint URL or record, the issue and requested action, the evidence supporting it, and a way for the operator to acknowledge and clarify the report. Avoid sending unnecessary personal information. Urgent safety reports should describe the foreseeable harm and affected model/design revision as precisely as possible.</p>

      <h2>Immediate handling</h2>
      <p>A credible urgent safety claim places the affected edge on hold immediately. A credible rights notice can place the design or source on hold. Both actions remove affected catalogue claims from search and sitemap while preserving the triggering report and decision history privately.</p>

      <h2>Review and outcome</h2>
      <p>A reviewer checks the source, creator, licence state, exact model and revision, evidence, and all related edges; then corrects, disputes, rejects, archives, or restores the record with an objective reason and audit trail. An appeal route must be part of the final counsel-reviewed process.</p>

      <h2>Launch blockers retained</h2>
      <p>No legal approval, regulatory classification, response-time guarantee, or final emergency process is claimed here. Qualified counsel must review the Iceland/EU service classification and final notice procedure, and operations must assign and test the channel before launch.</p>
    </div>
  );
}
