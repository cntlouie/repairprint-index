import type { Metadata } from "next";
import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";

export const metadata: Metadata = { title: "Report a fit", robots: { index: false, follow: true } };
export const dynamic = "force-dynamic";

export default async function ConfirmFitPage({ searchParams }: { searchParams: Promise<{ part?: string; submitted?: string; error?: string }> }) {
  const state = await searchParams;
  const demoMode = process.env.DEMO_MODE !== "false";
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Fitment evidence</span><h1>Report what happened</h1>
      <p className="lede narrow">A print failure is not counted as a fit failure. A modified fit is recorded separately from a no-modification fit.</p>
      {demoMode ? <div className="success-panel">Demo mode: this form is a simulation and nothing is stored.</div> : null}
      {state.submitted ? <div className="success-panel">{demoMode ? "Demo submission simulated; nothing was saved." : "Report received for private moderation."}</div> : null}
      {state.error ? <div className="error-panel">Check the required fields and try again.</div> : null}
      <form className="structured-form" action="/api/v1/submissions/fit-confirmations" method="post">
        <label>RepairPrint part slug<input name="partSlug" required defaultValue={state.part ?? ""} maxLength={200} /></label>
        <div className="form-grid"><label>Exact product model<input name="modelNumber" required maxLength={120} /></label><label>Design revision tested<input name="designRevision" required maxLength={80} /></label></div>
        <label>Outcome<select name="outcome" required defaultValue=""><option value="" disabled>Choose one</option><option value="fits_without_modification">Fits without modification</option><option value="fits_after_modification">Fits after modification</option><option value="does_not_fit">Does not fit</option><option value="print_failed">Print failed before testing</option><option value="unsure">Unsure</option></select></label>
        <label>Modification or failure details<textarea name="modificationNotes" maxLength={2000} rows={4} /></label>
        <label>Material and print settings<textarea name="printSettings" maxLength={2000} rows={4} /></label>
        <label>Evidence link (optional)<input name="evidenceUrl" type="url" placeholder="Link to a photo you control" /></label>
        <OptionalSubmissionContact emailLabel="Email for moderator follow-up (optional)" />
        <SubmissionProtectionFields action="fit_confirmation" />
        <SubmissionSubmitButton>Send for review</SubmissionSubmitButton>
      </form>
    </div>
  );
}
