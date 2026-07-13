import type { Metadata } from "next";
import { AccessibleFormValidation } from "@/components/AccessibleFormValidation";
import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";
import { PrivateMediaFields } from "@/components/PrivateMediaFields";
import { SubmissionPageStatus } from "@/components/SubmissionPageStatus";
import { currentSeoPage, seoMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return { title: "Submit a design", ...seoMetadata(currentSeoPage("/submit-design")) };
}
export const dynamic = "force-dynamic";

export default async function SubmitDesignPage({ searchParams }: { searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const state = await searchParams;
  const demoMode = process.env.DEMO_MODE !== "false";
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Creator-first indexing</span><h1>Submit a printable repair design</h1>
      <p className="lede narrow" id="submit-design-guidance">Send the original repository page. RepairPrint records attribution and links back; it does not accept STL uploads in v0. Required fields are marked “required”.</p>
      {demoMode ? <div className="info-panel" role="note">Demo mode: this form is a simulation and nothing is stored.</div> : null}
      <SubmissionPageStatus error={Boolean(state.error)} submitted={Boolean(state.submitted)} successMessage={demoMode ? "Demo submission simulated; nothing was saved." : "Design link received for private moderation."} />
      <form aria-describedby="submit-design-guidance" className="structured-form" action="/api/v1/submissions/designs" method="post" data-return-path="/submit-design">
        <AccessibleFormValidation />
        <label htmlFor="design-url">Original design URL (required)<input id="design-url" name="sourceUrl" type="url" required autoComplete="url" /></label>
        <label htmlFor="design-creator">Creator name or handle (required)<input id="design-creator" name="creatorName" required maxLength={120} autoComplete="off" /></label>
        <div className="form-grid"><label htmlFor="design-brand">Product brand (required)<input id="design-brand" name="brand" required maxLength={100} autoComplete="off" /></label><label htmlFor="design-model">Exact model number claimed (required)<input id="design-model" name="modelNumber" required maxLength={120} autoComplete="off" /></label></div>
        <label htmlFor="design-component">Broken component (required)<input id="design-component" name="componentName" required maxLength={160} autoComplete="off" /></label>
        <label htmlFor="design-license">Licence shown on the original page (required)<input id="design-license" name="claimedLicense" required maxLength={80} placeholder="Example: CC BY 4.0 or NOT-STATED" autoComplete="off" /></label>
        <label htmlFor="design-notes">Print settings or fit evidence<span className="field-help" id="design-notes-help">Do not paste private contact details or repository descriptions you do not have permission to share.</span><textarea aria-describedby="design-notes-help" id="design-notes" name="notes" maxLength={2000} rows={5} /></label>
        <OptionalSubmissionContact emailLabel="Email for moderator follow-up (optional)" />
        <SubmissionProtectionFields action="design_submission" />
        <PrivateMediaFields kind="design_submission" />
        <SubmissionSubmitButton>Send for review</SubmissionSubmitButton>
      </form>
    </div>
  );
}
