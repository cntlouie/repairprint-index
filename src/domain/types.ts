export const FITMENT_STATUSES = [
  "verified_fit",
  "community_confirmed",
  "creator_listed",
  "candidate_match",
  "disputed",
  "rejected",
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
  rulesetVersion: FitmentRulesetVersion;
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
  "high_speed_rotation",
  "gas_or_pressure",
  "gas_fuel_flame_combustion",
  "hazardous_chemical_containment",
  "vehicle_control",
  "lifting_towing_restraint",
  "fall_protection",
  "fire_or_heat_protection",
  "structural_high_load",
  "structural_overhead",
  "protective_guard",
  "ppe",
  "alarm_or_fire_safety",
  "food_contact",
  "infant_use",
  "child_safety",
  "medical_or_mobility",
  "medical_or_life_safety",
] as const;

export type SafetySignal = (typeof SAFETY_SIGNALS)[number];
export type SafetyClass = "low" | "caution" | "blocked";

export const FAILURE_CONSEQUENCES = [
  "injury",
  "fire",
  "electric_shock",
  "gas_release",
  "vehicle_control_loss",
  "collapse",
  "life_safety_failure",
] as const;

export type FailureConsequence = (typeof FAILURE_CONSEQUENCES)[number];
export type FitmentRulesetVersion = "fitment-v1";
export type SafetyRulesetVersion = "safety-v1";

export interface SafetyDecision {
  rulesetVersion: SafetyRulesetVersion;
  safetyClass: SafetyClass;
  reasons: string[];
  publishInMvp: boolean;
}

export interface PublishabilityInput {
  fitmentStatus: FitmentStatus;
  safetyClass: SafetyClass;
  sourcePolicy: "current_permitted" | "stale" | "blocked" | "permission_missing";
  originalLandingPageAvailable: boolean;
  creatorRecorded: boolean;
  attributionComplete: boolean;
  licenseRecorded: boolean;
  exactTargetRecorded: boolean;
  claimProvenanceComplete: boolean;
  safetyReviewed: boolean;
  openRightsOrSafetyNotice: boolean;
  designRevisionIdentified: boolean;
  designRevisionCurrent: boolean;
  fitmentRulesetVersion: string;
  safetyRulesetVersion: string;
  sourceRetrievedAt?: string;
  sourceLastCheckedAt?: string;
}

export interface PublishabilityDecision {
  publish: boolean;
  index: boolean;
  blockers: string[];
  errorCodes: PublicationErrorCode[];
}

export type PublicationErrorCode =
  | "SRC-001"
  | "SRC-002"
  | "RIGHTS-001"
  | "RIGHTS-002"
  | "RIGHTS-003"
  | "RIGHTS-004"
  | "RIGHTS-005"
  | "SAFE-001"
  | "SAFE-002"
  | "SAFE-003"
  | "SAFE-004"
  | "FIT-001"
  | "FIT-002"
  | "FIT-003"
  | "FIT-004"
  | "FIT-005"
  | "PROV-001"
  | "UGC-001"
  | "UGC-002"
  | "UGC-003"
  | "LINK-001";
