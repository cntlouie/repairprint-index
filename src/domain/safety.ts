import { CURRENT_SAFETY_RULESET } from "./rulesets";
import type { FailureConsequence, SafetyDecision, SafetySignal } from "./types";

const BLOCKED_SIGNALS = new Set<SafetySignal>([
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
]);

const CAUTION_SIGNALS = new Set<SafetySignal>([
  "repeated_load",
  "moving_part",
  "meaningful_heat",
  "water_exposure",
  "chemical_exposure",
  "uv_exposure",
]);

export interface SafetyAssessmentInput {
  signals: SafetySignal[];
  plausibleFailureConsequences?: FailureConsequence[];
}

export function assessSafety(input: SafetyAssessmentInput): SafetyDecision {
  const signals = [...new Set(input.signals)].sort();
  const consequences = [...new Set(input.plausibleFailureConsequences ?? [])].sort();

  if (consequences.length > 0) {
    return {
      rulesetVersion: CURRENT_SAFETY_RULESET,
      safetyClass: "blocked",
      reasons: consequences.map(
        (consequence) => `Publication-blocking failure consequence: ${consequence.replaceAll("_", " ")}.`,
      ),
      publishInMvp: false,
    };
  }

  const blocked = signals.filter((signal) => BLOCKED_SIGNALS.has(signal));
  if (blocked.length > 0) {
    return {
      rulesetVersion: CURRENT_SAFETY_RULESET,
      safetyClass: "blocked",
      reasons: blocked.map((signal) => `Blocked MVP safety signal: ${signal.replaceAll("_", " ")}.`),
      publishInMvp: false,
    };
  }

  const caution = signals.filter((signal) => CAUTION_SIGNALS.has(signal));
  if (caution.length > 0) {
    return {
      rulesetVersion: CURRENT_SAFETY_RULESET,
      safetyClass: "caution",
      reasons: caution.map((signal) => `Manual specialist review required: ${signal.replaceAll("_", " ")}.`),
      publishInMvp: false,
    };
  }

  return {
    rulesetVersion: CURRENT_SAFETY_RULESET,
    safetyClass: "low",
    reasons: ["No blocked or caution signal was recorded in the MVP screening taxonomy."],
    publishInMvp: true,
  };
}
