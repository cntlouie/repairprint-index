import type { Metadata } from "next";
import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";

export const metadata: Metadata = { title: "Request a missing part", robots: { index: false, follow: true } };
export const dynamic = "force-dynamic";

export default async function RequestPartPage({ searchParams }: { searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const state = await searchParams;
  const demoMode = process.env.DEMO_MODE !== "false";
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Research queue</span><h1>Request a missing part</h1>
      <p className="lede narrow">Use the exact text from the product label. Requests are reviewed privately and never become public pages automatically.</p>
      {demoMode ? <div className="success-panel">Demo mode: this form is a simulation and nothing is stored.</div> : null}
      {state.submitted ? <div className="success-panel">{demoMode ? "Demo submission simulated; nothing was saved." : "Request received for private review."}</div> : null}
      {state.error ? <div className="error-panel">Check the required fields and try again.</div> : null}
      <form className="structured-form" action="/api/v1/submissions/requests" method="post">
        <div className="form-grid"><label>Brand<input name="brand" required maxLength={100} /></label><label>Exact model number<input name="modelNumber" required maxLength={120} /></label></div>
        <label>What broke?<input name="brokenPart" required minLength={2} maxLength={160} placeholder="Example: dust-bin release latch" /></label>
        <label>OEM part number, if known<input name="oemPartNumber" maxLength={120} /></label>
        <label>What can you tell us?<textarea name="notes" maxLength={2000} rows={5} placeholder="Where the part sits, markings, dimensions, or links you already found" /></label>
        <OptionalSubmissionContact emailLabel="Email for a future match alert (optional)" />
        <SubmissionProtectionFields action="missing_part" />
        <SubmissionSubmitButton>Send request</SubmissionSubmitButton>
      </form>
    </div>
  );
}
