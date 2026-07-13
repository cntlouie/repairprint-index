import { resolvePrivateMediaConfig } from "@/lib/private-media-config";
import { PrivateMediaFieldsClient } from "./PrivateMediaFieldsClient";

export function PrivateMediaFields({ kind }: { kind: "missing_part" | "fit_confirmation" | "design_submission" }) {
  let config: ReturnType<typeof resolvePrivateMediaConfig> | undefined;
  try {
    config = resolvePrivateMediaConfig();
  } catch { /* fail closed below */ }
  if (!config) return <p className="error-panel" role="status">Private photo intake is temporarily unavailable. You can still send the text contribution.</p>;
  return <PrivateMediaFieldsClient kind={kind} versions={{ privacy: config.privacyVersion, retention: config.retentionVersion, terms: config.termsVersion }} />;
}
