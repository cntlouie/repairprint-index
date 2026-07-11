import type { Metadata } from "next";

export const metadata: Metadata = { title: "Report a fit", robots: { index: false, follow: true } };

export default async function ConfirmFitPage({ searchParams }: { searchParams: Promise<{ part?: string; submitted?: string; saved?: string; error?: string }> }) {
  const state = await searchParams;
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Fitment evidence</span><h1>Report what happened</h1>
      <p className="lede narrow">A print failure is not counted as a fit failure. A modified fit is recorded separately from a no-modification fit.</p>
      {state.submitted ? <div className="success-panel">Report received for moderation{state.saved === "0" ? " in preview mode (not persisted)" : ""}.</div> : null}
      {state.error ? <div className="error-panel">Check the required fields and try again.</div> : null}
      <form className="structured-form" action="/api/v1/submissions/fit-confirmations" method="post">
        <label>RepairPrint part slug<input name="partSlug" required defaultValue={state.part ?? ""} maxLength={200} /></label>
        <div className="form-grid"><label>Exact product model<input name="modelNumber" required maxLength={120} /></label><label>Design revision tested<input name="designRevision" required maxLength={80} /></label></div>
        <label>Outcome<select name="outcome" required defaultValue=""><option value="" disabled>Choose one</option><option value="fits_without_modification">Fits without modification</option><option value="fits_after_modification">Fits after modification</option><option value="does_not_fit">Does not fit</option><option value="print_failed">Print failed before testing</option><option value="unsure">Unsure</option></select></label>
        <label>Modification or failure details<textarea name="modificationNotes" maxLength={2000} rows={4} /></label>
        <label>Material and print settings<textarea name="printSettings" maxLength={2000} rows={4} /></label>
        <label>Evidence link (optional)<input name="evidenceUrl" type="url" placeholder="Link to a photo you control" /></label>
        <label>Email for moderator follow-up (optional)<input name="email" type="email" /></label>
        <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <button className="button-primary" type="submit">Send for review</button>
      </form>
    </div>
  );
}
