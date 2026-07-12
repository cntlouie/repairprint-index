import { describe, expect, it } from "vitest";

import {
  canonicalSubmissionContent,
  canonicalSubmissionDedupeContent,
  privateSubmissionPayload,
} from "@/domain/submissions";
import {
  designSubmissionIntakeSchema,
  fitConfirmationIntakeSchema,
  missingPartRequestIntakeSchema,
  storedHttpUrlSchema,
} from "@/lib/submission-schemas";

const controls = {
  challengeToken: "verified-token",
  contributionConsent: true,
  emailFollowUpConsent: false,
  idempotencyKey: "8f1dbf2c-3a55-4f7e-95c0-622293865f23",
  privacyConsent: true,
  website: "",
};

describe("anonymous contribution schemas", () => {
  it("requires both private-queue consents", () => {
    const fixture = { ...missingPartFixture(), privacyConsent: false };
    expect(missingPartRequestIntakeSchema.safeParse(fixture).success).toBe(false);
    expect(missingPartRequestIntakeSchema.safeParse({ ...missingPartFixture(), contributionConsent: false }).success).toBe(false);
  });

  it("requires separate email follow-up consent only when contact is supplied", () => {
    expect(missingPartRequestIntakeSchema.safeParse({ ...missingPartFixture(), email: "person@example.invalid" }).success).toBe(false);
    expect(missingPartRequestIntakeSchema.safeParse({
      ...missingPartFixture(),
      email: " PERSON@EXAMPLE.INVALID ",
      emailFollowUpConsent: true,
    }).data?.email).toBe("person@example.invalid");
    expect(missingPartRequestIntakeSchema.safeParse(missingPartFixture()).success).toBe(true);
  });

  it("rejects unknown fields rather than silently persisting them", () => {
    expect(missingPartRequestIntakeSchema.safeParse({ ...missingPartFixture(), moderationStatus: "accepted" }).success).toBe(false);
  });

  it("caps the single-use challenge token at the provider limit", () => {
    expect(missingPartRequestIntakeSchema.safeParse({
      ...missingPartFixture(),
      challengeToken: "x".repeat(2049),
    }).success).toBe(false);
  });

  it.each(["https://example.invalid/design", "http://example.invalid/evidence"])(
    "accepts storage-only HTTP(S) URL %s",
    (url) => expect(storedHttpUrlSchema.safeParse(url).success).toBe(true),
  );

  it.each([
    "ftp://example.invalid/file",
    "file:///tmp/private",
    "javascript:alert(1)",
    "data:text/plain,secret",
    "https://user:password@example.invalid/private",
    "not a url",
  ])("rejects unsafe stored URL %s", (url) => {
    expect(storedHttpUrlSchema.safeParse(url).success).toBe(false);
  });

  it("keeps all five fit outcomes distinct", () => {
    const outcomes = [
      "fits_without_modification",
      "fits_after_modification",
      "does_not_fit",
      "print_failed",
      "unsure",
    ] as const;
    expect(outcomes.map((outcome) => fitConfirmationIntakeSchema.parse({ ...fitFixture(), outcome }).outcome)).toEqual(outcomes);
  });

  it("validates design links under the same consent and URL boundary", () => {
    expect(designSubmissionIntakeSchema.safeParse(designFixture()).success).toBe(true);
    expect(designSubmissionIntakeSchema.safeParse({ ...designFixture(), sourceUrl: "file:///secret.stl" }).success).toBe(false);
  });

  it("removes every control/contact field before private queue persistence", () => {
    const intake = missingPartRequestIntakeSchema.parse({
      ...missingPartFixture(),
      email: "person@example.invalid",
      emailFollowUpConsent: true,
    });
    const payload = privateSubmissionPayload(intake);
    expect(payload).toEqual({
      brand: "DemoVac",
      brokenPart: "dust-bin latch",
      modelNumber: "DV-100",
      notes: "",
      oemPartNumber: "",
    });
    expect(JSON.stringify(payload)).not.toMatch(/email|challenge|consent|website|idempotency/i);
  });

  it("fingerprints print failures separately from fit failures", () => {
    const printFailure = privateSubmissionPayload(fitConfirmationIntakeSchema.parse({ ...fitFixture(), outcome: "print_failed" }));
    const noFit = privateSubmissionPayload(fitConfirmationIntakeSchema.parse({ ...fitFixture(), outcome: "does_not_fit" }));
    expect(canonicalSubmissionContent("fit_confirmation", printFailure)).not.toBe(
      canonicalSubmissionContent("fit_confirmation", noFit),
    );
  });

  it("deduplicates harmless demand variants without using free-form notes", () => {
    const left = { brand: " DemoVac ", brokenPart: "Dust-bin latch", modelNumber: "DV - 100", notes: "first note", oemPartNumber: "OEM-01" };
    const right = { brand: "demovac", brokenPart: "dust bin latch", modelNumber: "dv-100", notes: "different note", oemPartNumber: "oem-01" };
    expect(canonicalSubmissionDedupeContent("missing_part", left)).toBe(
      canonicalSubmissionDedupeContent("missing_part", right),
    );
  });

  it("never deduplicates punctuation-distinct ambiguous exact models", () => {
    const fixture = { brand: "DemoVac", brokenPart: "Dust-bin latch", notes: "", oemPartNumber: "" };
    expect(canonicalSubmissionDedupeContent("missing_part", { ...fixture, modelNumber: "DV-100" })).not.toBe(
      canonicalSubmissionDedupeContent("missing_part", { ...fixture, modelNumber: "DV/100" }),
    );
    const fit = { designRevision: "r2", outcome: "does_not_fit", partSlug: "dust-bin-latch-r2" };
    expect(canonicalSubmissionDedupeContent("fit_confirmation", { ...fit, modelNumber: "DV-100" })).not.toBe(
      canonicalSubmissionDedupeContent("fit_confirmation", { ...fit, modelNumber: "DV/100" }),
    );
  });

  it("keeps punctuation-distinct brand scopes separate", () => {
    const fixture = { brokenPart: "Latch", modelNumber: "DV-100", notes: "", oemPartNumber: "" };
    expect(canonicalSubmissionDedupeContent("missing_part", { ...fixture, brand: "A-B" })).not.toBe(
      canonicalSubmissionDedupeContent("missing_part", { ...fixture, brand: "AB" }),
    );
  });

  it("keeps distinct Unicode component descriptions instead of reducing them to an empty key", () => {
    const fixture = { brand: "DemoVac", modelNumber: "DV-100", notes: "", oemPartNumber: "" };
    expect(canonicalSubmissionDedupeContent("missing_part", { ...fixture, brokenPart: "l\u00e6sing" })).not.toBe(
      canonicalSubmissionDedupeContent("missing_part", { ...fixture, brokenPart: "\u9501\u6263" }),
    );
    expect(canonicalSubmissionDedupeContent("missing_part", { ...fixture, brokenPart: "dust-bin latch" })).toBe(
      canonicalSubmissionDedupeContent("missing_part", { ...fixture, brokenPart: "Dust bin latch" }),
    );
  });
});

function missingPartFixture() {
  return {
    ...controls,
    brand: "DemoVac",
    brokenPart: "dust-bin latch",
    modelNumber: "DV-100",
  };
}

function fitFixture() {
  return {
    ...controls,
    designRevision: "r2",
    modelNumber: "DV-100",
    outcome: "unsure",
    partSlug: "dust-bin-latch-r2",
  };
}

function designFixture() {
  return {
    ...controls,
    brand: "DemoVac",
    claimedLicense: "CC BY 4.0",
    componentName: "Dust-bin latch",
    creatorName: "Fixture creator",
    modelNumber: "DV-100",
    sourceUrl: "https://example.invalid/original-design",
  };
}
