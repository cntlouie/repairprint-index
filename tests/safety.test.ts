import { describe, expect, it } from "vitest";
import { assessSafety } from "@/domain/safety";
import { FAILURE_CONSEQUENCES, SAFETY_SIGNALS } from "@/domain/types";

describe("assessSafety", () => {
  it.each(["cosmetic", "low_load_clip", "external_adapter"] as const)(
    "allows low-risk %s parts",
    (signal) => expect(assessSafety({ signals: [signal] }).safetyClass).toBe("low"),
  );

  it.each([
    "repeated_load",
    "moving_part",
    "meaningful_heat",
    "water_exposure",
    "chemical_exposure",
    "uv_exposure",
  ] as const)("defers caution signal %s", (signal) => {
    const result = assessSafety({ signals: [signal] });
    expect(result.safetyClass).toBe("caution");
    expect(result.publishInMvp).toBe(false);
  });

  it.each(SAFETY_SIGNALS.filter((signal) => ![
    "cosmetic",
    "low_load_clip",
    "external_adapter",
    "repeated_load",
    "moving_part",
    "meaningful_heat",
    "water_exposure",
    "chemical_exposure",
    "uv_exposure",
  ].includes(signal))) (
    "blocks %s",
    (signal) => expect(assessSafety({ signals: [signal] }).safetyClass).toBe("blocked"),
  );

  it.each(FAILURE_CONSEQUENCES)("automatically blocks plausible %s consequences", (consequence) => {
    const result = assessSafety({ signals: ["cosmetic"], plausibleFailureConsequences: [consequence] });
    expect(result.safetyClass).toBe("blocked");
    expect(result.publishInMvp).toBe(false);
  });

  it("is deterministic regardless of duplicate signal order", () => {
    expect(assessSafety({ signals: ["moving_part", "repeated_load", "moving_part"] }))
      .toEqual(assessSafety({ signals: ["repeated_load", "moving_part"] }));
  });
});
