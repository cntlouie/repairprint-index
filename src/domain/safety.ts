import type { SafetyDecision, SafetySignal } from "./types";

const BLOCKED_SIGNALS = new Set<SafetySignal>([
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
]);

const CAUTION_SIGNALS = new Set<SafetySignal>([
  "repeated_load",
  "moving_part",
  "meaningful_heat",
  "water_exposure",
  "chemical_exposure",
  "uv_exposure",
]);

export function assessSafety(signals: SafetySignal[]): SafetyDecision {
  const blocked = signals.filter((signal) => BLOCKED_SIGNALS.has(signal));
  if (blocked.length > 0) {
    return {
      safetyClass: "blocked",
      reasons: blocked.map((signal) => `Blocked MVP safety signal: ${signal.replaceAll("_", " ")}.`),
      publishInMvp: false,
    };
  }

  const caution = signals.filter((signal) => CAUTION_SIGNALS.has(signal));
  if (caution.length > 0) {
    return {
      safetyClass: "caution",
      reasons: caution.map((signal) => `Manual specialist review required: ${signal.replaceAll("_", " ")}.`),
      publishInMvp: false,
    };
  }

  return {
    safetyClass: "low",
    reasons: ["No blocked or caution signal was recorded in the MVP screening taxonomy."],
    publishInMvp: true,
  };
}
