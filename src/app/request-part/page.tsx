import type { Metadata } from "next";
import { AccessibleFormValidation } from "@/components/AccessibleFormValidation";
import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";
import { PrivateMediaFields } from "@/components/PrivateMediaFields";
import { SubmissionPageStatus } from "@/components/SubmissionPageStatus";
import { currentSeoPage, seoMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return { title: "Request a missing part", ...seoMetadata(currentSeoPage("/request-part")) };
}
export const dynamic = "force-dynamic";

export default async function RequestPartPage({ searchParams }: { searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const state = await searchParams;
  const demoMode = process.env.DEMO_MODE !== "false";
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Research queue</span><h1>Request a missing part</h1>
      <p className="lede narrow" id="request-part-guidance">Use the exact text from the product label. Requests are reviewed privately and never become public pages automatically. Required fields are marked “required”.</p>
      {demoMode ? <div className="info-panel" role="note">Demo mode: this form is a simulation and nothing is stored.</div> : null}
      <SubmissionPageStatus error={Boolean(state.error)} submitted={Boolean(state.submitted)} successMessage={demoMode ? "Demo submission simulated; nothing was saved." : "Request received for private review."} />
      <form aria-describedby="request-part-guidance" className="structured-form" action="/api/v1/submissions/requests" method="post" data-return-path="/request-part">
        <AccessibleFormValidation />
        <div className="form-grid"><label htmlFor="request-brand">Brand (required)<input id="request-brand" name="brand" required maxLength={100} autoComplete="off" /></label><label htmlFor="request-model">Exact model number (required)<input id="request-model" name="modelNumber" required maxLength={120} autoComplete="off" /></label></div>
        <label htmlFor="request-broken-part">What broke? (required)<input id="request-broken-part" name="brokenPart" required minLength={2} maxLength={160} placeholder="Example: dust-bin release latch" autoComplete="off" /></label>
        <label htmlFor="request-oem">OEM part number, if known<input id="request-oem" name="oemPartNumber" maxLength={120} autoComplete="off" /></label>
        <label htmlFor="request-notes">What can you tell us?<span className="field-help" id="request-notes-help">Do not include passwords, serial numbers, or unnecessary personal information.</span><textarea aria-describedby="request-notes-help" id="request-notes" name="notes" maxLength={2000} rows={5} placeholder="Where the part sits, markings, dimensions, or links you already found" /></label>
        <OptionalSubmissionContact emailLabel="Email for a future match alert (optional)" />
        <SubmissionProtectionFields action="missing_part" />
        <PrivateMediaFields kind="missing_part" />
        <SubmissionSubmitButton>Send request</SubmissionSubmitButton>
      </form>
    </div>
  );
}
