import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { SubmissionProtectionFields, SubmissionSubmitButton } from "@/components/SubmissionProtectionFields";
import { OptionalSubmissionContact } from "@/components/OptionalSubmissionContact";

const originalEnvironment = { ...process.env };

describe("anonymous contribution forms", () => {
  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it("renders per-request idempotency, explicit consent and demo verification without uploads", () => {
    process.env.DEMO_MODE = "true";
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    const first = renderToStaticMarkup(React.createElement(SubmissionProtectionFields, { action: "missing_part" }));
    const second = renderToStaticMarkup(React.createElement(SubmissionProtectionFields, { action: "missing_part" }));
    const contact = renderToStaticMarkup(React.createElement(OptionalSubmissionContact, { emailLabel: "Optional email" }));
    const firstKey = first.match(/name="idempotencyKey"[^>]*value="([^"]+)"/)?.[1];
    const secondKey = second.match(/name="idempotencyKey"[^>]*value="([^"]+)"/)?.[1];
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(first).toContain("privacyConsent");
    expect(first).toContain("contributionConsent");
    expect(first).toContain('id="submission-privacy-consent"');
    expect(first).toContain('id="submission-contribution-consent"');
    expect(contact).toContain("emailFollowUpConsent");
    expect(contact).toContain('id="submission-email-consent"');
    expect(contact).not.toContain('name="emailFollowUpConsent" type="checkbox" required=""');
    expect(first).toContain("XXXX.DUMMY.TOKEN.XXXX");
    expect(first).not.toContain('type="file"');
  });

  it("makes the browser email consent conditional while leaving the server schema authoritative", () => {
    const source = readFileSync("src/components/OptionalSubmissionContact.tsx", "utf8");
    expect(source).toContain("required={hasEmail}");
    expect(source).toContain('name="emailFollowUpConsent"');
  });

  it("renders only the official Turnstile script/widget contract when configured", () => {
    process.env.DEMO_MODE = "false";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "public-site-key-fixture";
    process.env.TURNSTILE_SECRET_KEY = "server-secret-fixture";
    process.env.SUBMISSION_RETENTION_POLICY_VERSION = "wp08-test-retention-v1";
    process.env.SUBMISSION_RETENTION_DAYS = "30";
    process.env.SUBMISSION_CONTACT_RETENTION_DAYS = "14";
    const markup = renderToStaticMarkup(React.createElement(SubmissionProtectionFields, { action: "fit_confirmation" }));
    expect(markup).toContain('data-sitekey="public-site-key-fixture"');
    expect(markup).toContain('data-action="fit_confirmation"');
    expect(markup).toContain('data-response-field-name="challengeToken"');
    expect(markup).not.toContain("TURNSTILE_SECRET_KEY");
    expect(readFileSync("src/components/SubmissionProtectionFields.tsx", "utf8"))
      .toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
  });

  it("disables production intake without exposing missing retention configuration", () => {
    process.env.DEMO_MODE = "false";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "public-site-key-fixture";
    process.env.TURNSTILE_SECRET_KEY = "server-secret-fixture";
    delete process.env.SUBMISSION_RETENTION_POLICY_VERSION;
    delete process.env.SUBMISSION_RETENTION_DAYS;
    delete process.env.SUBMISSION_CONTACT_RETENTION_DAYS;

    const protection = renderToStaticMarkup(React.createElement(SubmissionProtectionFields, { action: "design_submission" }));
    const button = renderToStaticMarkup(React.createElement(SubmissionSubmitButton, null, "Send"));
    expect(protection).toContain("Contribution intake is not fully configured");
    expect(protection).not.toContain("public-site-key-fixture");
    expect(protection).not.toMatch(/SUBMISSION_RETENTION|wp08-test-retention/i);
    expect(button).toContain("disabled");
  });

  it.each([
    "src/app/request-part/page.tsx",
    "src/app/confirm-fit/page.tsx",
    "src/app/submit-design/page.tsx",
  ])("keeps %s request-rendered, noindex and on the canonical v1 endpoint", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain('dynamic = "force-dynamic"');
    expect(source).toContain("seoMetadata(currentSeoPage(");
    expect(source).toContain('action="/api/v1/submissions/');
    expect(source).toContain('method="post"');
    expect(source).toContain("<AccessibleFormValidation />");
    expect(source).toContain("Demo submission simulated; nothing was saved.");
    expect(source).not.toContain("/api/submissions/");
    expect(source).not.toContain('type="file"');
    expect(source).not.toContain("noValidate");
  });

  it("enhances native invalid events without intercepting valid form submission", () => {
    const source = readFileSync("src/components/AccessibleFormValidation.tsx", "utf8");
    expect(source).toContain('form.addEventListener("invalid", handleInvalid, true)');
    expect(source).toContain('control.setAttribute("aria-invalid", "true")');
    expect(source).toContain('control.setAttribute("aria-describedby"');
    expect(source).toContain("validation-error-${fieldId}");
    expect(source).toContain("event.preventDefault()");
    expect(source).not.toContain('form.addEventListener("submit"');
    expect(source).not.toContain("control.value");
  });
});
