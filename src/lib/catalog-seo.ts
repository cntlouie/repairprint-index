import type { CatalogueSeoFacts } from "@/domain/seo";
import type { CatalogModel, CatalogPart, CatalogPartSummary } from "./catalog-types";

export function catalogModelMaterialUpdatedAt(
  model: CatalogModel,
  parts: readonly CatalogPartSummary[],
): string {
  const timestamps = [model.updatedAt, ...parts.map((part) => part.updatedAt)]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return new Date(Math.max(...timestamps)).toISOString();
}

export function modelCatalogueSeoFacts(
  model: CatalogModel,
  parts: readonly CatalogPartSummary[],
): CatalogueSeoFacts {
  const hasIdentifierProvenance = model.identifiers.some((identifier) => Boolean(identifier.citation));
  return Object.freeze({
    entityType: "model",
    recordState: "published",
    publishedExactModel: Boolean(model.publicId && model.brandSlug && model.modelSlug && hasIdentifierProvenance),
    lowRiskSafetyApproved: parts.length > 0 && parts.every((part) => part.safetyClass === "low"),
    qualifyingLiveDesigns: new Set(parts.map((part) => part.slug)).size,
    visible: Object.freeze({
      creator: parts.some((part) => part.creator.trim().length > 0),
      source: parts.some((part) => part.platform.trim().length > 0),
      licence: parts.some((part) => part.licenseCode.trim().length > 0),
      evidence: parts.some((part) => part.evidenceCount > 0),
      lastCheckedAt: parts.some((part) => validDate(part.sourceLastCheckedAt)),
      provenance: hasIdentifierProvenance && parts.some((part) => part.evidenceCount > 0),
    }),
    uniqueRepairInformation: model.identifiers.length > 0 && parts.length > 0,
  });
}

export function partCatalogueSeoFacts(part: CatalogPart): CatalogueSeoFacts {
  const fitments = part.fitments;
  const optionalFactsHaveVisibleProvenance = (part.commonNames.length === 0 || Boolean(part.commonNameCitation))
    && part.oemParts.every((oem) => oem.citations.length > 0);
  return Object.freeze({
    entityType: "part",
    recordState: "published",
    publishedExactModel: fitments.length > 0 && fitments.every((fitment) => Boolean(fitment.model.publicId)),
    lowRiskSafetyApproved: fitments.length > 0 && fitments.every((fitment) => fitment.safety.safetyClass === "low"),
    qualifyingLiveDesigns: new Set(fitments.map((fitment) => fitment.revision.id)).size,
    visible: Object.freeze({
      creator: part.design.creator.trim().length > 0,
      source: fitments.every((fitment) => fitment.source.available && fitment.source.title.trim().length > 0),
      licence: fitments.every((fitment) => fitment.revision.licenseCode.trim().length > 0),
      evidence: fitments.every((fitment) => fitment.evidence.length > 0),
      lastCheckedAt: fitments.every((fitment) => validDate(fitment.source.lastCheckedAt)),
      provenance: optionalFactsHaveVisibleProvenance
        && fitments.every((fitment) => fitment.evidence.some((evidence) => Boolean(evidence.citation))),
    }),
    uniqueRepairInformation: part.name.trim().length > 0 && fitments.length > 0,
  });
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
