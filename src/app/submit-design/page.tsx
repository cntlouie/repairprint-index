import type { Metadata } from "next";
import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";
import { PrivateMediaFields } from "@/components/PrivateMediaFields";

export const metadata: Metadata = { title: "Submit a design", robots: { index: false, follow: true } };
export const dynamic = "force-dynamic";

export default async function SubmitDesignPage({ searchParams }: { searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const state = await searchParams;
  const demoMode = process.env.DEMO_MODE !== "false";
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Creator-first indexing</span><h1>Submit a printable repair design</h1>
      <p className="lede narrow">Send the original repository page. RepairPrint records attribution and links back; it does not accept STL uploads in v1.</p>
      {demoMode ? <div className="success-panel">Demo mode: this form is a simulation and nothing is stored.</div> : null}
      {state.submitted ? <div className="success-panel">{demoMode ? "Demo submission simulated; nothing was saved." : "Design link received for private moderation."}</div> : null}
      {state.error ? <div className="error-panel">Check the required fields and try again.</div> : null}
      <form className="structured-form" action="/api/v1/submissions/designs" method="post" data-return-path="/submit-design">
        <label>Original design URL<input name="sourceUrl" type="url" required /></label>
        <label>Creator name or handle<input name="creatorName" required maxLength={120} /></label>
        <div className="form-grid"><label>Product brand<input name="brand" required maxLength={100} /></label><label>Exact model number claimed<input name="modelNumber" required maxLength={120} /></label></div>
        <label>Broken component<input name="componentName" required maxLength={160} /></label>
        <label>Licence shown on the original page<input name="claimedLicense" required maxLength={80} placeholder="Example: CC BY 4.0 or not stated" /></label>
        <label>Print settings or fit evidence<textarea name="notes" maxLength={2000} rows={5} /></label>
        <OptionalSubmissionContact emailLabel="Email for moderator follow-up (optional)" />
        <SubmissionProtectionFields action="design_submission" />
        <PrivateMediaFields kind="design_submission" />
        <SubmissionSubmitButton>Send for review</SubmissionSubmitButton>
      </form>
    </div>
  );
}
