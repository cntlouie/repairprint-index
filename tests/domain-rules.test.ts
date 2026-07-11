import { describe, expect, it } from "vitest";
import { PUBLICATION_ERROR_CODES } from "@/domain/error-codes";
import {
  CURRENT_FITMENT_RULESET,
  CURRENT_SAFETY_RULESET,
  RULESET_PACKAGE_VERSION,
} from "@/domain/rulesets";

describe("versioned domain rules package", () => {
  it("locks the initial evaluator versions", () => {
    expect({
      package: RULESET_PACKAGE_VERSION,
      fitment: CURRENT_FITMENT_RULESET,
      safety: CURRENT_SAFETY_RULESET,
    }).toEqual({
      package: "domain-rules-v1",
      fitment: "fitment-v1",
      safety: "safety-v1",
    });
  });

  it("publishes the complete documented stable error-code vocabulary", () => {
    expect(PUBLICATION_ERROR_CODES).toMatchObject({
      "SRC-001": "SOURCE_TERMS_BLOCKED",
      "SRC-002": "API_OR_PERMISSION_MISSING",
      "RIGHTS-001": "LICENSE_NOT_RECORDED",
      "RIGHTS-002": "COMMERCIAL_REUSE_NOT_ALLOWED",
      "RIGHTS-003": "IMAGE_RIGHTS_UNKNOWN",
      "RIGHTS-004": "ATTRIBUTION_INCOMPLETE",
      "RIGHTS-005": "ORIGINAL_UPLOAD_UNCONFIRMED",
      "SAFE-001": "EXCLUDED_FAILURE_CONSEQUENCE",
      "SAFE-002": "SAFETY_REVIEW_INCOMPLETE",
      "SAFE-003": "FITMENT_PRESENTED_AS_SAFETY",
      "FIT-001": "MODEL_AMBIGUOUS",
      "FIT-002": "FITMENT_EVIDENCE_INSUFFICIENT",
      "FIT-003": "OPEN_FITMENT_DISPUTE",
      "FIT-004": "CONFIDENCE_STALE",
      "UGC-001": "CONTRIBUTOR_RIGHTS_GRANT_MISSING",
      "UGC-002": "PERSONAL_DATA_REVIEW_REQUIRED",
      "UGC-003": "OPEN_TAKEDOWN_OR_SAFETY_NOTICE",
      "LINK-001": "SOURCE_REMOVED_OR_RESTRICTED",
    });
  });
});
