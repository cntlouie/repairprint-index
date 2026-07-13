"use client";

import { useEffect, useRef } from "react";

export function SubmissionPageStatus({
  error,
  submitted,
  successMessage,
}: Readonly<{
  error: boolean;
  submitted: boolean;
  successMessage: string;
}>) {
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error || submitted) statusRef.current?.focus();
  }, [error, submitted]);

  if (error) {
    return (
      <div ref={statusRef} className="error-panel" role="alert" tabIndex={-1}>
        <strong>Contribution not queued.</strong> Check the required fields identified below and try again.
      </div>
    );
  }
  if (submitted) {
    return (
      <div ref={statusRef} className="success-panel" role="status" aria-live="polite" tabIndex={-1}>
        {successMessage}
      </div>
    );
  }
  return null;
}
