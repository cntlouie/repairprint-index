import type { Metadata } from "next";
import { AccessibleFormValidation } from "@/components/AccessibleFormValidation";
import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";
import { PrivateMediaFields } from "@/components/PrivateMediaFields";
import { SubmissionPageStatus } from "@/components/SubmissionPageStatus";
import { currentSeoPage, seoMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return { title: "Report a fit", ...seoMetadata(currentSeoPage("/confirm-fit")) };
}
export const dynamic = "force-dynamic";

export default async function ConfirmFitPage({ searchParams }: { searchParams: Promise<{ part?: string; submitted?: string; error?: string }> }) {
  const state = await searchParams;
  const demoMode = process.env.DEMO_MODE !== "false";
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Fitment evidence</span><h1>Report what happened</h1>
      <p className="lede narrow" id="confirm-fit-guidance">A print failure is not counted as a fit failure. A modified fit is recorded separately from a no-modification fit. Required fields are marked “required”.</p>
      {demoMode ? <div className="info-panel" role="note">Demo mode: this form is a simulation and nothing is stored.</div> : null}
      <SubmissionPageStatus error={Boolean(state.error)} submitted={Boolean(state.submitted)} successMessage={demoMode ? "Demo submission simulated; nothing was saved." : "Report received for private moderation."} />
      <form aria-describedby="confirm-fit-guidance" className="structured-form" action="/api/v1/submissions/fit-confirmations" method="post" data-return-path="/confirm-fit">
        <AccessibleFormValidation />
        <label htmlFor="fit-part-slug">RepairPrint part reference (required)<input id="fit-part-slug" name="partSlug" required defaultValue={state.part ?? ""} maxLength={200} autoComplete="off" /></label>
        <div className="form-grid"><label htmlFor="fit-model">Exact product model (required)<input id="fit-model" name="modelNumber" required maxLength={120} autoComplete="off" /></label><label htmlFor="fit-revision">Design revision tested (required)<input id="fit-revision" name="designRevision" required maxLength={80} autoComplete="off" /></label></div>
        <label htmlFor="fit-outcome">Outcome (required)<select id="fit-outcome" name="outcome" required defaultValue=""><option value="" disabled>Choose one</option><option value="fits_without_modification">Fits without modification</option><option value="fits_after_modification">Fits after modification</option><option value="does_not_fit">Does not fit</option><option value="print_failed">Print failed before testing</option><option value="unsure">Unsure</option></select></label>
        <label htmlFor="fit-details">Modification or failure details<span className="field-help" id="fit-details-help">Explain modifications or why fit could not be tested; do not include a serial number or personal information.</span><textarea aria-describedby="fit-details-help" id="fit-details" name="modificationNotes" maxLength={2000} rows={4} /></label>
        <label htmlFor="fit-settings">Material and print settings<textarea id="fit-settings" name="printSettings" maxLength={2000} rows={4} /></label>
        <label htmlFor="fit-evidence-url">Evidence link (optional)<input id="fit-evidence-url" name="evidenceUrl" type="url" autoComplete="url" placeholder="Link to a photo you control" /></label>
        <OptionalSubmissionContact emailLabel="Email for moderator follow-up (optional)" />
        <SubmissionProtectionFields action="fit_confirmation" />
        <PrivateMediaFields kind="fit_confirmation" />
        <SubmissionSubmitButton>Send for review</SubmissionSubmitButton>
      </form>
    </div>
  );
}
