import type { FitmentStatus } from "@/domain/types";

const LABELS: Record<FitmentStatus, string> = {
  verified_fit: "Verified fit",
  community_confirmed: "Community confirmed",
  creator_listed: "Creator listed",
  candidate_match: "Candidate match",
  disputed: "Disputed",
};

export function StatusBadge({ status }: { status: FitmentStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
