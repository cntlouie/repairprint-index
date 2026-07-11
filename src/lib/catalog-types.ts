import type { FitmentEvidence, FitmentStatus, SafetyClass } from "@/domain/types";
import type { LicenseCode } from "@/domain/license";
import type { Route } from "next";

export interface CatalogModel {
  id: string;
  brandName: string;
  brandSlug: string;
  modelName: string;
  modelSlug: string;
  identifiers: string[];
  categoryName: string;
  categorySlug: string;
  region: string;
  summary: string;
}

export interface CatalogPart {
  id: string;
  slug: string;
  name: string;
  description: string;
  componentName: string;
  oemPartNumbers: string[];
  modelIds: string[];
  fitmentStatus: FitmentStatus;
  safetyClass: SafetyClass;
  safetyNotice: string;
  evidence: FitmentEvidence[];
  design: {
    title: string;
    revision: string;
    creator: string;
    platform: string;
    sourceUrl: string;
    licenseCode: LicenseCode;
    retrievedAt: string;
    lastCheckedAt: string;
  };
  printRecipe: {
    material: string;
    orientation: string;
    layerHeight: string;
    walls: string;
    infill: string;
    supports: string;
    extraHardware: string;
    provenance: "creator_sourced" | "community_sourced" | "editorial";
  };
  publishedAt: string;
  updatedAt: string;
  isDemo: boolean;
}

export interface SearchResult {
  type: "model" | "part";
  title: string;
  subtitle: string;
  href: Route;
  matchReason: string;
  rank: number;
}
