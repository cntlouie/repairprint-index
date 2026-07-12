"use client";

import { useState } from "react";

export function OptionalSubmissionContact({ emailLabel }: { emailLabel: string }) {
  const [email, setEmail] = useState("");
  const hasEmail = email.trim().length > 0;

  return (
    <div className="optional-contact-fields">
      <label>
        {emailLabel}
        <input
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
      </label>
      <label className="checkbox-label">
        <input name="emailFollowUpConsent" type="checkbox" required={hasEmail} />
        If I entered an email, RepairPrint may use it only for this contribution, moderator questions, or the requested match alert.
      </label>
    </div>
  );
}
