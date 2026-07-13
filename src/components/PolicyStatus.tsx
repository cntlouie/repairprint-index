export const POLICY_LAST_REVIEWED_ISO = "2026-07-13";
export const POLICY_LAST_REVIEWED_LABEL = "13 July 2026";

export function PolicyStatus({ scope }: { scope: string }) {
  return (
    <p className="policy-status" role="status">
      <strong>Status:</strong> engineering operating draft · {scope} · last reviewed {POLICY_LAST_REVIEWED_LABEL}.
      Qualified Iceland/EU counsel review and named operational ownership remain open launch gates.
    </p>
  );
}
