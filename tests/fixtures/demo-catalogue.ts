import type { FitmentEvidence, FitmentStatus, SafetyClass } from "@/domain/types";

export interface DemoCataloguePart {
  slug: string;
  modelIds: string[];
  fitmentStatus: FitmentStatus;
  safetyClass: SafetyClass;
  evidence: FitmentEvidence[];
  sourceUrl: string;
  creator: string;
  licenseCode: string;
}

export const demoModels = [
  { id: "fixture-model-dv100", label: "DemoVac DV-100" },
  { id: "fixture-model-dv200", label: "DemoVac DV-200" },
] as const;

export const demoParts: DemoCataloguePart[] = [
  {
    slug: "fixture-dv100-dust-bin-latch",
    modelIds: ["fixture-model-dv100"],
    fitmentStatus: "verified_fit",
    safetyClass: "low",
    sourceUrl: "https://example.invalid/fixtures/dv100-latch",
    creator: "Fixture creator",
    licenseCode: "CC-BY",
    evidence: [{
      id: "fixture-evidence-test",
      kind: "trusted_physical_test",
      outcome: "fits_without_modification",
      moderationStatus: "accepted",
      exactModel: true,
      exactDesignRevision: true,
      installedPhoto: true,
      measurements: true,
      observedAt: "2026-07-01",
      summary: "Explicit fictional test fixture for an exact revision and model.",
    }],
  },
  {
    slug: "fixture-hose-retainer",
    modelIds: ["fixture-model-dv100", "fixture-model-dv200"],
    fitmentStatus: "community_confirmed",
    safetyClass: "low",
    sourceUrl: "https://example.invalid/fixtures/hose-retainer",
    creator: "Fixture maker",
    licenseCode: "CC-BY-SA",
    evidence: [
      {
        id: "fixture-community-a",
        kind: "community_report",
        outcome: "fits_without_modification",
        moderationStatus: "accepted",
        exactModel: true,
        exactDesignRevision: true,
        reporterKey: "fixture-a",
        installedPhoto: true,
        measurements: false,
        observedAt: "2026-06-20",
        summary: "First explicit community fixture.",
      },
      {
        id: "fixture-community-b",
        kind: "community_report",
        outcome: "fits_without_modification",
        moderationStatus: "accepted",
        exactModel: true,
        exactDesignRevision: true,
        reporterKey: "fixture-b",
        installedPhoto: false,
        measurements: true,
        observedAt: "2026-06-27",
        summary: "Second independent community fixture.",
      },
    ],
  },
];
