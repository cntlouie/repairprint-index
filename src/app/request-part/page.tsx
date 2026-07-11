import type { Metadata } from "next";

export const metadata: Metadata = { title: "Request a missing part", robots: { index: false, follow: true } };

export default async function RequestPartPage({ searchParams }: { searchParams: Promise<{ submitted?: string; saved?: string; error?: string }> }) {
  const state = await searchParams;
  return (
    <div className="shell page-shell form-page">
      <span className="eyebrow">Research queue</span><h1>Request a missing part</h1>
      <p className="lede narrow">Use the exact text from the product label. Requests are reviewed privately and never become public pages automatically.</p>
      {state.submitted ? <div className="success-panel">Request received{state.saved === "0" ? " in preview mode (not persisted)" : ""}.</div> : null}
      {state.error ? <div className="error-panel">Check the required fields and try again.</div> : null}
      <form className="structured-form" action="/api/v1/submissions/requests" method="post">
        <div className="form-grid"><label>Brand<input name="brand" required maxLength={100} /></label><label>Exact model number<input name="modelNumber" required maxLength={120} /></label></div>
        <label>What broke?<input name="brokenPart" required minLength={2} maxLength={160} placeholder="Example: dust-bin release latch" /></label>
        <label>OEM part number, if known<input name="oemPartNumber" maxLength={120} /></label>
        <label>What can you tell us?<textarea name="notes" maxLength={2000} rows={5} placeholder="Where the part sits, markings, dimensions, or links you already found" /></label>
        <label>Email for a future match alert (optional)<input name="email" type="email" /></label>
        <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <button className="button-primary" type="submit">Send request</button>
      </form>
    </div>
  );
}
