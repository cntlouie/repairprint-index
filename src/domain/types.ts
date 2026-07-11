export const FITMENT_STATUSES = [
  "verified_fit",
  "community_confirmed",
  "creator_listed",
  "candidate_match",
  "disputed",
] as const;

export type FitmentStatus = (typeof FITMENT_STATUSES)[number];

export const FIT_OUTCOMES = [
  "fits_without_modification",
  "fits_after_modification",
  "does_not_fit",
  "print_failed",
  "unsure",
] as const;

export type FitOutcome = (typeof FIT_OUTCOMES)[number];

export type EvidenceKind =
  | "trusted_physical_test"
  | "community_report"
  | "creator_claim"
  | "oem_mapping"
  | "dimensional_match"
  | "editorial_note";

export interface FitmentEvidence {
  id: string;
  kind: EvidenceKind;
  outcome?: FitOutcome;
  moderationStatus: "pending" | "accepted" | "rejected";
  exactModel: boolean;
  exactDesignRevision: boolean;
  reporterKey?: string;
  installedPhoto: boolean;
  measurements: boolean;
  modificationNotes?: string;
  observedAt: string;
  sourceUrl?: string;
  summary: string;
}

export interface FitmentDecision {
  status: FitmentStatus;
  score: number;
  reasons: string[];
  acceptedPositiveReports: number;
  acceptedNegativeReports: number;
}

export const SAFETY_SIGNALS = [
  "cosmetic",
  "low_load_clip",
  "external_adapter",
  "repeated_load",
  "moving_part",
  "meaningful_heat",
  "water_exposure",
  "chemical_exposure",
  "uv_exposure",
  "mains_electricity",
  "battery_or_charging",
  "motor_or_impeller",
  "gas_or_pressure",
  "fire_or_heat_protection",
  "structural_high_load",
  "protective_guard",
  "food_contact",
  "child_safety",
  "medical_or_life_safety",
] as const;

export type SafetySignal = (typeof SAFETY_SIGNALS)[number];
export type SafetyClass = "low" | "caution" | "blocked";

export interface SafetyDecision {
  safetyClass: SafetyClass;
  reasons: string[];
  publishInMvp: boolean;
}

export interface PublishabilityInput {
  fitmentStatus: FitmentStatus;
  safetyClass: SafetyClass;
  sourceIsLive: boolean;
  creatorRecorded: boolean;
  licenseRecorded: boolean;
  exactTargetRecorded: boolean;
  safetyReviewed: boolean;
  sourceRetrievedAt?: string;
  sourceLastCheckedAt?: string;
}

export interface PublishabilityDecision {
  publish: boolean;
  index: boolean;
  blockers: string[];
}
