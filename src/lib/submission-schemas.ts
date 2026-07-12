import { z } from "zod";
import { parse as parseUuid, stringify as stringifyUuid } from "uuid";

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional().default("");

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.union([z.email().max(320), z.literal("")]).optional(),
);

const literalUrlControl = /[\u0000-\u001f\u007f-\u009f]/u;
const malformedPercentEscape = /%(?![0-9a-f]{2})/iu;
const encodedAsciiControlOrBackslash = /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/iu;

export const storedHttpUrlSchema = z.string().max(2048).transform((rawValue, context) => {
  const value = rawValue.trim();
  if (
    !value
    || literalUrlControl.test(rawValue)
    || rawValue.includes("\\")
    || !value.isWellFormed()
    || !/^https?:\/\//iu.test(value)
    || hasUnsafePercentEncoding(value)
  ) {
    context.addIssue({
      code: "custom",
      message: "Only a canonical HTTP(S) URL without controls, backslashes or credentials can be stored.",
    });
    return z.NEVER;
  }

  try {
    const parsed = new URL(value);
    const canonical = parsed.toString();
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || canonical.length > 2048
    ) {
      throw new TypeError("Unsafe stored URL");
    }
    return canonical;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Only a canonical HTTP(S) URL without controls, backslashes or credentials can be stored.",
    });
    return z.NEVER;
  }
});

function hasUnsafePercentEncoding(value: string): boolean {
  let layer = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    if (malformedPercentEscape.test(layer)) return true;
    if (literalUrlControl.test(layer) || layer.includes("\\") || encodedAsciiControlOrBackslash.test(layer)) {
      return true;
    }
    if (!layer.includes("%")) return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(layer);
    } catch {
      return true;
    }
    if (decoded === layer) return false;
    layer = decoded;
  }
  return true;
}

const optionalStoredHttpUrl = z.union([storedHttpUrlSchema, z.literal("")]).optional().default("");

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

const checkedConsentDecision = z.preprocess(
  (value) => value === true || value === "true" || value === "on" || value === "1",
  z.boolean(),
);

export const canonicalSubmissionClientUuidSchema = z.string().transform((value, context) => {
  try {
    return stringifyUuid(parseUuid(value));
  } catch {
    context.addIssue({
      code: "custom",
      message: "A canonical UUID is required.",
    });
    return z.NEVER;
  }
});

const intakeControlShape = {
  email: optionalEmail,
  privacyConsent: checkedConsentDecision,
  contributionConsent: checkedConsentDecision,
  emailFollowUpConsent: checkedConsentDecision,
  idempotencyKey: canonicalSubmissionClientUuidSchema,
  challengeToken: z.string().trim().min(1).max(2048),
  website: z.string().max(200).optional().default(""),
} as const;

function requireNewSubmissionConsent<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.strict().superRefine((value, context) => {
    const intake = value as {
      contributionConsent: boolean;
      email?: string;
      emailFollowUpConsent: boolean;
      privacyConsent: boolean;
    };
    if (!intake.privacyConsent) {
      context.addIssue({
        code: "custom",
        path: ["privacyConsent"],
        message: "Privacy consent is required.",
      });
    }
    if (!intake.contributionConsent) {
      context.addIssue({
        code: "custom",
        path: ["contributionConsent"],
        message: "Contribution consent is required.",
      });
    }
    if (intake.email && !intake.emailFollowUpConsent) {
      context.addIssue({
        code: "custom",
        path: ["emailFollowUpConsent"],
        message: "Email follow-up consent is required when an email address is provided.",
      });
    }
  });
}

export const missingPartRequestIntakeStructuralSchema = missingPartRequestSchema
  .extend(intakeControlShape)
  .strict();

export const fitConfirmationIntakeStructuralSchema = fitConfirmationSchema
  .extend(intakeControlShape)
  .strict();

export const designSubmissionIntakeStructuralSchema = designSubmissionSchema
  .extend(intakeControlShape)
  .strict();

export const missingPartRequestIntakeSchema = requireNewSubmissionConsent(
  missingPartRequestSchema.extend(intakeControlShape),
);

export const fitConfirmationIntakeSchema = requireNewSubmissionConsent(
  fitConfirmationSchema.extend(intakeControlShape),
);

export const designSubmissionIntakeSchema = requireNewSubmissionConsent(
  designSubmissionSchema.extend(intakeControlShape),
);

export function hasRequiredNewSubmissionConsent(intake: Readonly<{
  contributionConsent: boolean;
  email?: string;
  emailFollowUpConsent: boolean;
  privacyConsent: boolean;
}>): boolean {
  return intake.privacyConsent
    && intake.contributionConsent
    && (!intake.email || intake.emailFollowUpConsent);
}

export type MissingPartRequestInput = z.infer<typeof missingPartRequestSchema>;
export type FitConfirmationInput = z.infer<typeof fitConfirmationSchema>;
export type DesignSubmissionInput = z.infer<typeof designSubmissionSchema>;
export type MissingPartRequestIntake = z.infer<typeof missingPartRequestIntakeStructuralSchema>;
export type FitConfirmationIntake = z.infer<typeof fitConfirmationIntakeStructuralSchema>;
export type DesignSubmissionIntake = z.infer<typeof designSubmissionIntakeStructuralSchema>;
export type AnonymousSubmissionIntake =
  | MissingPartRequestIntake
  | FitConfirmationIntake
  | DesignSubmissionIntake;
