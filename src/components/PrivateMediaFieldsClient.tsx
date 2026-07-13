"use client";

import { useEffect, useRef, useState } from "react";

type Props = Readonly<{
  kind: "missing_part" | "fit_confirmation" | "design_submission";
  versions: Readonly<{ privacy: string; retention: string; terms: string }>;
}>;

export function PrivateMediaFieldsClient({ kind, versions }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const purposeRef = useRef<HTMLSelectElement>(null);
  const ownershipRef = useRef<HTMLInputElement>(null);
  const storageRef = useRef<HTMLInputElement>(null);
  const derivativeRef = useRef<HTMLInputElement>(null);
  const publicDisplayRef = useRef<HTMLInputElement>(null);
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const [status, setStatus] = useState("");

  async function intercept(event: SubmitEvent, form: HTMLFormElement) {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    event.preventDefault();
    setStatus("Sending the text contribution first…");
    try {
      const textResponse = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form) as never), headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" } });
      const textResult = await textResponse.json() as { id?: string; error?: { code?: string } };
      if (!textResponse.ok || !textResult.id) throw new Error(textResult.error?.code ?? "TEXT_SUBMISSION_FAILED");
      const data = new FormData(form);
      const extension = file.name.split(".").pop()?.toLowerCase();
      setStatus("Text received. Preparing the private photo…");
      const sessionResponse = await fetch("/api/v1/private-media/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey: data.get("idempotencyKey"), receiptId: textResult.id, kind,
        purpose: purposeRef.current?.value, claimedBytes: file.size, claimedMimeType: file.type, claimedExtension: extension,
        ownsOrHasPermission: ownershipRef.current?.checked === true, privateStorage: storageRef.current?.checked === true,
        derivativeProcessing: derivativeRef.current?.checked === true, publicDisplay: publicDisplayRef.current?.checked === true,
        termsVersion: versions.terms, privacyVersion: versions.privacy, retentionVersion: versions.retention,
      }) });
      const session = await sessionResponse.json() as { mediaId?: string; uploadCapability?: string; finalizeCapability?: string; status?: string; error?: { code?: string } };
      if (!sessionResponse.ok || !session.mediaId) throw new Error(session.error?.code ?? "PHOTO_SESSION_FAILED");
      if (session.status === "simulated") { window.location.assign(`${form.dataset.returnPath}?submitted=1&media=simulated`); return; }
      if (session.status === "processed") { window.location.assign(`${form.dataset.returnPath}?submitted=1&media=processed`); return; }
      if (session.status === "processing") throw new Error("PHOTO_PROCESSING_IN_PROGRESS");
      let finalizeCapability = session.finalizeCapability;
      if (!finalizeCapability) {
        const uploadResponse = await fetch(`/api/v1/private-media/${encodeURIComponent(session.mediaId)}/upload`, { method: "PUT", body: file, headers: { authorization: `Bearer ${session.uploadCapability}`, "content-type": file.type } });
        const upload = await uploadResponse.json() as { finalizeCapability?: string; error?: { code?: string } };
        if (!uploadResponse.ok || !upload.finalizeCapability) throw new Error(upload.error?.code ?? "PHOTO_UPLOAD_FAILED");
        finalizeCapability = upload.finalizeCapability;
      }
      setStatus("Photo uploaded privately. Removing metadata and making review copies…");
      const finalizeResponse = await fetch(`/api/v1/private-media/${encodeURIComponent(session.mediaId)}/finalize`, { method: "POST", headers: { authorization: `Bearer ${finalizeCapability}` } });
      const finalized = await finalizeResponse.json() as { error?: { code?: string } };
      if (!finalizeResponse.ok) throw new Error(finalized.error?.code ?? "PHOTO_PROCESSING_FAILED");
      window.location.assign(`${form.dataset.returnPath}?submitted=1&media=processed`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "PHOTO_FAILED";
      setStatus(`Your text result may have succeeded, but the photo did not: ${code}. You may retry the photo with the same form token.`);
    }
  }

  useEffect(() => {
    const form = fieldsetRef.current?.closest("form");
    if (!form) return;
    const listener = (event: SubmitEvent) => { void intercept(event, form); };
    form.addEventListener("submit", listener);
    return () => form.removeEventListener("submit", listener);
  });

  return (
    <fieldset ref={fieldsetRef} className="consent-fields">
      <legend>Optional private photo</legend>
      <p>JPEG, PNG, WebP or AVIF; up to 10 MiB. Photos remain private in this work package.</p>
      <label>Photo purpose<select ref={purposeRef} defaultValue="broken_part_context"><option value="model_label">Model label</option><option value="installed_fit">Installed fit</option><option value="broken_part_context">Broken part or context</option></select></label>
      <label>Choose a photo<input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" /></label>
      <label className="checkbox-label"><input ref={ownershipRef} type="checkbox" />I own this photo or have permission to provide it.</label>
      <label className="checkbox-label"><input ref={storageRef} type="checkbox" />I agree to private storage under the stated retention policy.</label>
      <label className="checkbox-label"><input ref={derivativeRef} type="checkbox" />I agree to metadata removal, orientation correction, thumbnails and manual redaction derivatives.</label>
      <label className="checkbox-label"><input ref={publicDisplayRef} type="checkbox" />Optional, separate consent: RepairPrint may consider an approved redacted derivative for later public display.</label>
      <p>Leaving public display unchecked does not affect private review. Nothing publishes in WP-09.</p>
      {status ? <p role="status" aria-live="polite">{status}</p> : null}
    </fieldset>
  );
}
