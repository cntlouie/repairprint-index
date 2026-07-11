import { z } from "zod";

const optionalEmail = z.union([z.email(), z.literal("")]).optional();
const optionalUrl = z.union([z.url(), z.literal("")]).optional();

export const missingPartRequestSchema = z.object({
  brand: z.string().trim().min(1).max(100),
  modelNumber: z.string().trim().min(1).max(120),
  brokenPart: z.string().trim().min(2).max(160),
  oemPartNumber: z.string().trim().max(120).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  email: optionalEmail,
  website: z.string().max(0).optional().default(""),
});

export const fitConfirmationSchema = z.object({
  partSlug: z.string().trim().min(1).max(200),
  modelNumber: z.string().trim().min(1).max(120),
  designRevision: z.string().trim().min(1).max(80),
  outcome: z.enum([
    "fits_without_modification",
    "fits_after_modification",
    "does_not_fit",
    "print_failed",
    "unsure",
  ]),
  modificationNotes: z.string().trim().max(2000).optional().default(""),
  printSettings: z.string().trim().max(2000).optional().default(""),
  evidenceUrl: optionalUrl,
  email: optionalEmail,
  website: z.string().max(0).optional().default(""),
});

export const designSubmissionSchema = z.object({
  sourceUrl: z.url(),
  creatorName: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(100),
  modelNumber: z.string().trim().min(1).max(120),
  componentName: z.string().trim().min(2).max(160),
  claimedLicense: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(2000).optional().default(""),
  email: optionalEmail,
  website: z.string().max(0).optional().default(""),
});

export type MissingPartRequestInput = z.infer<typeof missingPartRequestSchema>;
export type FitConfirmationInput = z.infer<typeof fitConfirmationSchema>;
export type DesignSubmissionInput = z.infer<typeof designSubmissionSchema>;
