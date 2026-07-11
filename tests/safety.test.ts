import { describe, expect, it } from "vitest";
import { assessSafety } from "@/domain/safety";

describe("assessSafety", () => {
  it("allows low-load external parts", () => {
    expect(assessSafety(["low_load_clip", "cosmetic"]).safetyClass).toBe("low");
  });

  it("defers repeated-load parts", () => {
    const result = assessSafety(["repeated_load"]);
    expect(result.safetyClass).toBe("caution");
    expect(result.publishInMvp).toBe(false);
  });

  it.each(["mains_electricity", "battery_or_charging", "protective_guard", "food_contact"] as const)(
    "blocks %s",
    (signal) => expect(assessSafety([signal]).safetyClass).toBe("blocked"),
  );
});
