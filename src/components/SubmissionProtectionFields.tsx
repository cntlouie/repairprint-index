import Link from "next/link";
import Script from "next/script";

import { TURNSTILE_DEMO_TOKEN } from "@/lib/submission-constants";
import { isSubmissionRetentionConfigured } from "@/lib/submissions";

export function SubmissionProtectionFields({ action }: { action: string }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const demoMode = process.env.DEMO_MODE !== "false";
  const protectionAvailable = isSubmissionIntakeAvailable(demoMode, siteKey);

  return (
    <>
      <input name="idempotencyKey" type="hidden" value={crypto.randomUUID()} />
      <label className="honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <fieldset className="consent-fields">
        <legend>Private queue consent</legend>
        <label className="checkbox-label" htmlFor="submission-privacy-consent">
          <input id="submission-privacy-consent" name="privacyConsent" type="checkbox" required />
          I understand this contribution and its technical details are stored privately for moderation and retention review.
        </label>
        <label className="checkbox-label" htmlFor="submission-contribution-consent">
          <input id="submission-contribution-consent" name="contributionConsent" type="checkbox" required />
          I may share this information for RepairPrint review. It will not publish automatically, and a link does not transfer design-file rights.
        </label>
        <p>
          Read the versioned <Link href="/contribution-privacy">private contribution notice</Link>.
        </p>
      </fieldset>
      {protectionAvailable && siteKey ? (
        <>
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />
          <div
            className="cf-turnstile"
            data-sitekey={siteKey}
            data-action={action}
            data-response-field-name="challengeToken"
          />
        </>
      ) : protectionAvailable ? (
        <input name="challengeToken" type="hidden" value={TURNSTILE_DEMO_TOKEN} />
      ) : (
        <p className="error-panel" role="status">
          Contribution intake is not fully configured, so contributions are temporarily unavailable.
        </p>
      )}
    </>
  );
}

export function SubmissionSubmitButton({ children }: { children: React.ReactNode }) {
  const demoMode = process.env.DEMO_MODE !== "false";
  const available = isSubmissionIntakeAvailable(demoMode, process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  return (
    <button className="button-primary" type="submit" disabled={!available}>
      {children}
    </button>
  );
}

function isSubmissionIntakeAvailable(demoMode: boolean, siteKey: string | undefined): boolean {
  const challengeConfigured = demoMode || Boolean(siteKey && process.env.TURNSTILE_SECRET_KEY);
  return challengeConfigured && isSubmissionRetentionConfigured();
}
