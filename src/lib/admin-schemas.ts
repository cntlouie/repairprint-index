import { z } from "zod";

import { SAFETY_SIGNALS } from "@/domain/types";

const auditContext = {
  reason: z.string().trim().min(3).max(1000),
  requestId: z.string().trim().min(3).max(160),
};

export const prepareCreatorCaseSchema = z.object({
  productComponentId: z.uuid(),
  confirmExactTarget: z.literal(true),
  designTitle: z.string().trim().min(3).max(200),
  creatorPlatform: z.string().trim().min(1).max(80),
  sourcePlatform: z.string().trim().min(1).max(80),
  sourceExternalId: z.string().trim().min(1).max(160),
  sourceRevision: z.string().trim().min(1).max(80),
  sourceTitle: z.string().trim().min(3).max(240),
  licenseCode: z.string().trim().min(1).max(80),
  licenseVersion: z.string().trim().max(40).optional().default(""),
  licenseUrl: z.union([z.url(), z.literal("")]).optional().default(""),
  licenseEvidenceUrl: z.union([z.url(), z.literal("")]).optional().default(""),
  attributionText: z.string().trim().min(3).max(500),
  fileFormats: z.array(z.string().trim().min(1).max(20)).min(1).max(12),
  observedAt: z.iso.date(),
  evidenceSummary: z.string().trim().min(3).max(1000),
  ...auditContext,
});

export const reviewCreatorCaseSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  safetyClass: z.enum(["low", "caution", "blocked"]),
  safetySignals: z.array(z.enum(SAFETY_SIGNALS)).min(1),
  safetyRationale: z.string().trim().min(3).max(1000),
  ...auditContext,
});

export const publishCaseSchema = z.object(auditContext);

export const archiveFitmentSchema = z.object({
  replacementPath: z.string().trim().min(1).max(500),
  ...auditContext,
});

export const moderateEvidenceSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  ...auditContext,
});

export const catalogTargetDraftSchema = z.object({
  brandId: z.uuid(),
  categoryId: z.uuid(),
  sourceId: z.uuid(),
  sourceLocator: z.string().trim().min(1).max(500),
  modelPublicId: z.string().trim().min(3).max(100),
  modelName: z.string().trim().min(1).max(120),
  modelSlug: z.string().trim().min(1).max(140),
  marketCodes: z.array(z.string().trim().min(1).max(30)).min(1),
  identifierDisplay: z.string().trim().min(1).max(120),
  identifierType: z.string().trim().min(1).max(40),
  component: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("existing"), id: z.uuid() }),
    z.object({ mode: z.literal("new"), name: z.string().trim().min(2).max(160), slug: z.string().trim().min(2).max(180), commonNames: z.array(z.string().trim().min(1).max(120)) }),
  ]),
  oem: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }),
    z.object({ mode: z.literal("new"), publicId: z.string().trim().min(3).max(100), partNumberDisplay: z.string().trim().min(1).max(120), name: z.string().trim().min(2).max(160) }),
  ]),
  ...auditContext,
});

export type PrepareCreatorCaseInput = z.infer<typeof prepareCreatorCaseSchema>;
export type ReviewCreatorCaseInput = z.infer<typeof reviewCreatorCaseSchema>;
export type PublishCaseInput = z.infer<typeof publishCaseSchema>;
export type ArchiveFitmentInput = z.infer<typeof archiveFitmentSchema>;
export type ModerateEvidenceInput = z.infer<typeof moderateEvidenceSchema>;
export type CatalogTargetDraftInput = z.infer<typeof catalogTargetDraftSchema>;
