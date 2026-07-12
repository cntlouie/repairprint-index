import type { EvidenceKind, FitmentStatus, SafetyClass } from "@/domain/types";

export interface PublicCitation {
  sourceTitle: string;
  sourceUrl: string | null;
  sourceAvailable: boolean;
  locator: string | null;
  retrievedAt: string;
  lastCheckedAt: string;
}

export interface CatalogModelIdentifier {
  displayValue: string;
  identifierType: string;
  marketCode: string | null;
  citation: PublicCitation | null;
}

export interface CatalogModel {
  id: string;
  publicId: string;
  brandName: string;
  brandSlug: string;
  modelName: string;
  modelSlug: string;
  identifiers: CatalogModelIdentifier[];
  categoryName: string;
  categorySlug: string;
  marketCodes: string[];
  labelLocation: string | null;
  publishedAt: string;
  updatedAt: string;
}

export interface CatalogPartSummary {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  componentName: string;
  designTitle: string;
  revision: string;
  creator: string;
  platform: string;
  fitmentStatus: Exclude<FitmentStatus, "candidate_match" | "disputed" | "rejected">;
  safetyClass: "low";
  material: string | null;
  updatedAt: string;
}

export interface CatalogEvidence {
  id: string;
  kind: EvidenceKind;
  outcome: string | null;
  exactModel: boolean;
  exactDesignRevision: boolean;
  installedPhoto: boolean;
  measurementsRecorded: boolean;
  modificationNotes: string | null;
  summary: string;
  observedAt: string;
  citation: PublicCitation | null;
}

export interface CatalogPrintRecipe {
  material: string;
  nozzleMm: number | null;
  layerHeightMm: number | null;
  wallCount: number | null;
  infillPercent: number | null;
  supports: string | null;
  orientation: string | null;
  hardware: unknown;
  estimatedMinutes: number | null;
  provenance: string;
  citation: PublicCitation | null;
}

export interface CatalogFitment {
  id: string;
  publicId: string;
  slug: string;
  status: Exclude<FitmentStatus, "candidate_match" | "disputed" | "rejected">;
  model: {
    id: string;
    publicId: string;
    brandName: string;
    brandSlug: string;
    modelName: string;
    modelSlug: string;
    serialFrom: string | null;
    serialTo: string | null;
  };
  revision: {
    id: string;
    label: string;
    licenseCode: string;
    licenseVersion: string | null;
    licenseUrl: string | null;
    licenseEvidenceUrl: string | null;
    attributionText: string;
    fileFormats: string[];
    rightsCheckedAt: string;
  };
  source: {
    title: string;
    platform: string;
    url: string;
    publisher: string | null;
    retrievedAt: string;
    lastCheckedAt: string;
    available: true;
  };
  safety: {
    safetyClass: SafetyClass;
    signals: string[];
    failureConsequence: string;
    rationale: string;
    rulesetVersion: string;
    reviewedAt: string;
  };
  evidence: CatalogEvidence[];
  printRecipe: CatalogPrintRecipe | null;
  publishedAt: string;
  updatedAt: string;
}

export interface CatalogPart {
  canonicalSlug: string;
  name: string;
  componentSlug: string;
  commonNames: string[];
  oemParts: Array<{
    publicId: string;
    partNumber: string;
    name: string;
  }>;
  design: {
    id: string;
    publicId: string;
    title: string;
    creator: string;
    creatorPlatform: string;
    creatorProfileUrl: string | null;
  };
  fitments: CatalogFitment[];
  updatedAt: string;
}

export interface UnavailableCatalogPart {
  slug: string;
  publicId: string;
  name: string;
  designTitle: string;
  creator: string;
  modelLabel: string;
  sourceTitle: string;
  sourceLastCheckedAt: string;
  reason: "source_removed" | "design_unavailable";
  updatedAt: string;
}

export type CatalogPartLookup =
  | { kind: "published"; part: CatalogPart }
  | { kind: "unavailable"; part: UnavailableCatalogPart }
  | { kind: "redirect"; location: string }
  | { kind: "not_found" };

export interface CatalogInvalidationContext {
  modelPaths: Array<{ brandSlug: string; modelSlug: string }>;
  partSlugs: string[];
}
