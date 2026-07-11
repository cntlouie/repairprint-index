import type { Metadata } from "next";

export const metadata: Metadata = { title: "Submit a design", robots: { index: false, follow: true } };

export default async function SubmitDesignPage({ searchParams }: { searchParams: Promise<{ submitted?: string; saved?: string; error?: string }> }) {
  const state = await searchParams;
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Creator-first indexing</span><h1>Submit a printable repair design</h1>
      <p className="lede narrow">Send the original repository page. RepairPrint records attribution and links back; it does not accept STL uploads in v1.</p>
      {state.submitted ? <div className="success-panel">Design link received for moderation{state.saved === "0" ? " in preview mode (not persisted)" : ""}.</div> : null}
      {state.error ? <div className="error-panel">Check the required fields and try again.</div> : null}
      <form className="structured-form" action="/api/v1/submissions/designs" method="post">
        <label>Original design URL<input name="sourceUrl" type="url" required /></label>
        <label>Creator name or handle<input name="creatorName" required maxLength={120} /></label>
        <div className="form-grid"><label>Product brand<input name="brand" required maxLength={100} /></label><label>Exact model number claimed<input name="modelNumber" required maxLength={120} /></label></div>
        <label>Broken component<input name="componentName" required maxLength={160} /></label>
        <label>Licence shown on the original page<input name="claimedLicense" required maxLength={80} placeholder="Example: CC BY 4.0 or not stated" /></label>
        <label>Print settings or fit evidence<textarea name="notes" maxLength={2000} rows={5} /></label>
        <label>Email for moderator follow-up (optional)<input name="email" type="email" /></label>
        <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <button className="button-primary" type="submit">Send for review</button>
      </form>
    </div>
  );
}
