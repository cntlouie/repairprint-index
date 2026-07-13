"use client";

import { useState } from "react";

export function OptionalSubmissionContact({ emailLabel }: { emailLabel: string }) {
  const [email, setEmail] = useState("");
  const hasEmail = email.trim().length > 0;

  return (
    <div className="optional-contact-fields">
      <label htmlFor="submission-email">
        {emailLabel}
        <input
          id="submission-email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
      </label>
      <label className="checkbox-label" htmlFor="submission-email-consent">
        <input aria-describedby="email-consent-description" id="submission-email-consent" name="emailFollowUpConsent" type="checkbox" required={hasEmail} />
        <span id="email-consent-description">If I entered an email, RepairPrint may use it only for this contribution, moderator questions, or the requested match alert.</span>
      </label>
    </div>
  );
}
