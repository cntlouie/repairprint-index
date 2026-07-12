import { z } from "zod";

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional().default("");

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.union([z.email().max(320), z.literal("")]).optional(),
);

export const storedHttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }, "Only an HTTP(S) URL without embedded credentials can be stored.");

const optionalStoredHttpUrl = z.union([storedHttpUrlSchema, z.literal("")]).optional();

/** Private queue payload schemas. Control, contact, consent and anti-spam fields are deliberately absent. */
export const missingPartRequestSchema = z.object({
  brand: z.string().trim().min(1).max(100),
  modelNumber: z.string().trim().min(1).max(120),
  brokenPart: z.string().trim().min(2).max(160),
  oemPartNumber: optionalText(120),
  notes: optionalText(2000),
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
  modificationNotes: optionalText(2000),
  printSettings: optionalText(2000),
  evidenceUrl: optionalStoredHttpUrl,
});

export const designSubmissionSchema = z.object({
  sourceUrl: storedHttpUrlSchema,
  creatorName: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(100),
  modelNumber: z.string().trim().min(1).max(120),
  componentName: z.string().trim().min(2).max(160),
  claimedLicense: z.string().trim().min(1).max(80),
  notes: optionalText(2000),
});

const checkedConsent = z.preprocess(
  (value) => value === true || value === "true" || value === "on" || value === "1",
  z.literal(true),
);

const optionalCheckedConsent = z.preprocess(
  (value) => value === true || value === "true" || value === "on" || value === "1",
  z.boolean(),
);

const intakeControlShape = {
  email: optionalEmail,
  privacyConsent: checkedConsent,
  contributionConsent: checkedConsent,
  emailFollowUpConsent: optionalCheckedConsent,
  idempotencyKey: z.uuid(),
  challengeToken: z.string().trim().min(1).max(2048),
  website: z.string().max(200).optional().default(""),
} as const;

function requireContactConsent<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.strict().superRefine((value, context) => {
    const intake = value as { email?: string; emailFollowUpConsent?: boolean };
    if (intake.email && !intake.emailFollowUpConsent) {
      context.addIssue({
        code: "custom",
        path: ["emailFollowUpConsent"],
        message: "Email follow-up consent is required when an email address is provided.",
      });
    }
  });
}

export const missingPartRequestIntakeSchema = requireContactConsent(
  missingPartRequestSchema.extend(intakeControlShape),
);

export const fitConfirmationIntakeSchema = requireContactConsent(
  fitConfirmationSchema.extend(intakeControlShape),
);

export const designSubmissionIntakeSchema = requireContactConsent(
  designSubmissionSchema.extend(intakeControlShape),
);

export type MissingPartRequestInput = z.infer<typeof missingPartRequestSchema>;
export type FitConfirmationInput = z.infer<typeof fitConfirmationSchema>;
export type DesignSubmissionInput = z.infer<typeof designSubmissionSchema>;
export type MissingPartRequestIntake = z.infer<typeof missingPartRequestIntakeSchema>;
export type FitConfirmationIntake = z.infer<typeof fitConfirmationIntakeSchema>;
export type DesignSubmissionIntake = z.infer<typeof designSubmissionIntakeSchema>;
export type AnonymousSubmissionIntake =
  | MissingPartRequestIntake
  | FitConfirmationIntake
  | DesignSubmissionIntake;
