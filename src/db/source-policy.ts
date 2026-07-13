import "server-only";

import type { SourcePolicySnapshot } from "@/domain/source-policy";

export async function loadCurrentSourcePolicySnapshot(platform: string): Promise<SourcePolicySnapshot | null> {
  const { databaseClient } = await import("@/db/client");
  const [row] = await databaseClient<{
    platform: string;
    policy: SourcePolicySnapshot["policy"];
    policyVersion: string;
    termsCheckedAt: Date;
    expiresAt: Date;
    allowedFields: string[];
    automationAllowed: boolean;
    commercialUseAllowed: boolean | null;
    adapterEnabled: boolean;
    currentPolicyMatches: boolean;
  }[]>`
    SELECT policy.platform, policy.policy, review.policy_version AS "policyVersion",
      review.terms_checked_at AS "termsCheckedAt", review.expires_at AS "expiresAt",
      review.allowed_fields AS "allowedFields", review.automation_allowed AS "automationAllowed",
      review.commercial_use_allowed AS "commercialUseAllowed", review.adapter_enabled AS "adapterEnabled",
      (policy.permission_scope = 'review:' || review.policy_version
        AND policy.policy = review.decision
        AND policy.terms_url = review.terms_url
        AND policy.terms_checked_at = review.terms_checked_at
        AND policy.allowed_fields = review.allowed_fields
        AND policy.automation_allowed = review.automation_allowed
        AND policy.commercial_use_allowed IS NOT DISTINCT FROM review.commercial_use_allowed
        AND policy.adapter_enabled = review.adapter_enabled
        AND policy.image_reuse_allowed = false
        AND policy.file_rehosting_allowed = false) AS "currentPolicyMatches"
    FROM public.source_platform_policies AS policy
    INNER JOIN LATERAL (
      SELECT policy_review.* FROM public.source_policy_reviews AS policy_review
      WHERE policy_review.platform = policy.platform
      ORDER BY policy_review.reviewed_at DESC, policy_review.id DESC LIMIT 1
    ) AS review ON true
    WHERE policy.platform = ${platform}
  `;
  return row ? Object.freeze({ ...row, allowedFields: Object.freeze([...row.allowedFields]) }) : null;
}
