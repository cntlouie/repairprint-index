import { describe, expect, it } from "vitest";

import {
  canonicalSubmissionContent,
  canonicalSubmissionDedupeContent,
  canonicalSubmissionRequestFingerprint,
  privateSubmissionPayload,
} from "@/domain/submissions";
import {
  designSubmissionIntakeStructuralSchema,
  designSubmissionIntakeSchema,
  fitConfirmationIntakeStructuralSchema,
  fitConfirmationIntakeSchema,
  hasRequiredNewSubmissionConsent,
  missingPartRequestIntakeStructuralSchema,
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

  it.each([
    missingPartRequestIntakeStructuralSchema,
    fitConfirmationIntakeStructuralSchema,
    designSubmissionIntakeStructuralSchema,
  ])("structurally parses explicit consent decisions before new-only policy enforcement", (schema) => {
    const fixture = schema === missingPartRequestIntakeStructuralSchema
      ? missingPartFixture()
      : schema === fitConfirmationIntakeStructuralSchema
        ? fitFixture()
        : designFixture();
    const parsed = schema.parse({ ...fixture, contributionConsent: false, privacyConsent: false });
    expect(parsed).toMatchObject({ contributionConsent: false, privacyConsent: false });
    expect(hasRequiredNewSubmissionConsent(parsed)).toBe(false);
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

  it.each([
    ["https://example.invalid/design", "https://example.invalid/design"],
    ["http://example.invalid/evidence", "http://example.invalid/evidence"],
    [" HTTPS://ExAmPle.Invalid:443/a b?x=hello world#proof ", "https://example.invalid/a%20b?x=hello%20world#proof"],
    ["https://example.invalid/a%20safe%252Fpath", "https://example.invalid/a%20safe%252Fpath"],
    ["https://example.invalid/%F0%9F%98%80", "https://example.invalid/%F0%9F%98%80"],
  ])(
    "canonicalizes storage-only HTTP(S) URL %s",
    (url, canonical) => expect(storedHttpUrlSchema.parse(url)).toBe(canonical),
  );

  it.each([
    "ftp://example.invalid/file",
    "file:///tmp/private",
    "javascript:alert(1)",
    "data:text/plain,secret",
    "https://user:password@example.invalid/private",
    "https://example.invalid\\@evil.invalid/private",
    "https:\\example.invalid/private",
    "http:example.invalid/private",
    "http:/example.invalid/private",
    "//example.invalid/private",
    "https://example.invalid/%",
    "https://example.invalid/%0",
    "https://example.invalid/%GG",
    "https://example.invalid/%25GG",
    "https://example.invalid/%2525GG",
    "https://example.invalid/%C3",
    "https://example.invalid/%FF",
    "not a url",
  ])("rejects unsafe stored URL %s", (url) => {
    expect(storedHttpUrlSchema.safeParse(url).success).toBe(false);
  });

  it("rejects literal C0, C1 and DEL controls before URL parsing can erase or encode them", () => {
    for (const codePoint of [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x9f]) {
      const control = String.fromCharCode(codePoint);
      for (const url of [
        `${control}https://example.invalid/path`,
        `https://example.invalid/a${control}b`,
        `https://example.invalid/path${control}`,
      ]) {
        expect(storedHttpUrlSchema.safeParse(url).success, `U+${codePoint.toString(16).padStart(4, "0")}`).toBe(false);
      }
    }
  });

  it.each([
    "%00",
    "%0a",
    "%0D",
    "%1f",
    "%7f",
    "%80",
    "%9F",
    "%5c",
    "%5C",
    "%2500",
    "%25250A",
    "%255c",
    "%25255C",
    "%C2%80",
  ])("rejects encoded or multiply encoded control/backslash %s", (encoded) => {
    expect(storedHttpUrlSchema.safeParse(`https://example.invalid/a${encoded}b`).success).toBe(false);
  });

  it("rejects malformed Unicode instead of storing URL-parser replacement characters", () => {
    expect(storedHttpUrlSchema.safeParse(`https://example.invalid/${String.fromCharCode(0xd800)}`).success).toBe(false);
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

  it("normalizes omitted and empty fit evidence URLs through one canonical payload path", () => {
    const omitted = fitConfirmationIntakeStructuralSchema.parse(fitFixture());
    const explicit = fitConfirmationIntakeStructuralSchema.parse({ ...fitFixture(), evidenceUrl: "" });
    expect(omitted.evidenceUrl).toBe("");
    expect(explicit.evidenceUrl).toBe("");
    expect(privateSubmissionPayload(omitted)).toEqual(privateSubmissionPayload(explicit));
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

  it("includes every stable policy decision in the full request fingerprint material", () => {
    const base = {
      contact: { digest: "contact-digest", present: true },
      decisions: {
        contributionConsent: true,
        emailFollowUpConsent: true,
        privacyConsent: true,
      },
      kind: "missing_part" as const,
      payload: { brand: "DemoVac", modelNumber: "DV-100" },
      versions: {
        contactConsent: "contact-v1",
        contributorTerms: "terms-v1",
        privacyNotice: "privacy-v1",
        retentionPolicy: "retention-v1",
      },
    };
    const canonical = canonicalSubmissionRequestFingerprint(base);
    const variants = [
      { ...base, contact: { ...base.contact, digest: "different-digest" } },
      { ...base, contact: { digest: null, present: false } },
      { ...base, decisions: { ...base.decisions, contributionConsent: false } },
      { ...base, decisions: { ...base.decisions, emailFollowUpConsent: false } },
      { ...base, decisions: { ...base.decisions, privacyConsent: false } },
      { ...base, payload: { ...base.payload, modelNumber: "DV/100" } },
      { ...base, versions: { ...base.versions, contactConsent: "contact-v2" } },
      { ...base, versions: { ...base.versions, contributorTerms: "terms-v2" } },
      { ...base, versions: { ...base.versions, privacyNotice: "privacy-v2" } },
      { ...base, versions: { ...base.versions, retentionPolicy: "retention-v2" } },
    ];
    expect(variants.every((variant) => canonicalSubmissionRequestFingerprint(variant) !== canonical)).toBe(true);
    expect(canonical).not.toContain("person@example.invalid");
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
    const fit = { designRevision: "r2", outcome: "does_not_fit", partSlug: "dust-bin-latch-r2" };
    const exactAndLooseModels = ["DV-100", "DV/100", "DV100"];
    expect(new Set(exactAndLooseModels.map((modelNumber) =>
      canonicalSubmissionDedupeContent("missing_part", { ...fixture, modelNumber }))).size).toBe(3);
    expect(new Set(exactAndLooseModels.map((modelNumber) =>
      canonicalSubmissionDedupeContent("fit_confirmation", { ...fit, modelNumber }))).size).toBe(3);
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
