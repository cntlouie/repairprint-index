# Trust, safety, and moderation logic

## Two independent questions

1. **Does this exact design revision fit this exact product model?**
2. **Is indexing this application inside RepairPrint’s safety boundary?**

A “Verified fit” can still be blocked for safety. A low-risk safety review does not prove fitment.

## Public fitment labels

| Label | Deterministic requirement | Public treatment |
| --- | --- | --- |
| Verified fit | Accepted trusted physical test of exact revision on exact model; no unresolved negative | Highest placement |
| Community confirmed | Two distinct accepted exact-model/revision successes, at least one installed photo, no unresolved negative | Recommended with evidence count |
| Creator listed | Original designer explicitly lists exact model/revision, no credible negative | Available, clearly creator-claimed |
| Candidate match | Only dimensions, OEM mapping, family similarity, or machine suggestion | Separate candidate area; never confirmed/indexable alone |
| Disputed | Accepted exact-model/revision incompatibility conflicts with positive claim | Warning and removal from recommended results pending review |
| Rejected | Credible negative with no accepted positive or reviewer rejection | Not public search/index |

Precedence:

```text
if credible accepted exact-revision incompatibility exists:
    disputed or rejected
else if trusted exact physical success exists:
    verified_fit
else if >=2 distinct accepted exact successes and >=1 installed photo:
    community_confirmed
else if creator exact claim exists:
    creator_listed
else:
    candidate_match
```

An OEM catalogue proving two models share an original part is supporting evidence, not a verified printed fit. AI suggestions carry zero verification weight.

## Evidence quality rules

- Only accepted evidence participates.
- Deduplicate by independent actor; one creator reposted on several sites is one source.
- Exact model and exact design revision are required for confirmation.
- “Fits after modification” preserves the modification and does not become an unqualified exact fit.
- “Print failed” does not count as “does not fit.”
- One credible negative opens review; obvious slicer/printer failures are classified separately.
- New source revision means new fitment edge or re-evaluation; old evidence stays attached to the tested revision.

The application stores an internal score for ranking/queue priority, but the public sees the label, evidence count, evidence kinds, recency, and explanation—not a falsely precise percentage.

## V0 safety taxonomy

### Low-risk: potentially publishable after review

- Cosmetic covers
- Cable guides
- Low-load clips, latches, knobs, buttons, feet, and retainers
- External hose/nozzle/dust adapters where failure causes inconvenience, not exposure to a hazard

### Caution: keep internal during v0

- Repeated-load or moving parts
- Wheel supports or structural brackets
- Meaningful heat, water, chemicals, or UV
- Any use where material choice changes a foreseeable hazard

### Blocked

- Mains electricity, insulation, connectors, or enclosures
- Batteries, charging, motors, impellers, high-speed rotating parts
- Gas, fuel, flame, combustion, pressure, or hazardous chemical containment
- Braking, steering, lifting, towing, restraint, fall protection, or vehicle control
- Guards, PPE, medical/mobility devices, alarms, fire safety, child safety
- Structural/overhead/high-load parts
- Food-contact or infant-use parts without a separate qualified compliance process

Any plausible failure consequence involving injury, fire, shock, gas, vehicle control, collapse, or life safety automatically blocks publication.

## Publication gate

Publishing is a server-side transaction. It fails when any condition is true:

- Source policy is blocked/stale or acquisition method is not permitted
- Original landing page is missing/unavailable
- Creator or attribution is incomplete
- Licence state is absent
- Exact product/component target is absent
- Claim provenance is incomplete
- Safety review is missing, caution, or blocked
- Open rights/safety notice exists
- Fitment is rejected/disputed
- Confidence or safety was computed with an old ruleset
- Design revision is not current/identified

Suggested codes:

```text
SRC-001 SOURCE_TERMS_BLOCKED
SRC-002 API_OR_PERMISSION_MISSING
RIGHTS-001 LICENSE_NOT_RECORDED
RIGHTS-002 COMMERCIAL_REUSE_NOT_ALLOWED
RIGHTS-003 IMAGE_RIGHTS_UNKNOWN
RIGHTS-004 ATTRIBUTION_INCOMPLETE
RIGHTS-005 ORIGINAL_UPLOAD_UNCONFIRMED
SAFE-001 EXCLUDED_FAILURE_CONSEQUENCE
SAFE-002 SAFETY_REVIEW_INCOMPLETE
SAFE-003 FITMENT_PRESENTED_AS_SAFETY
FIT-001 MODEL_AMBIGUOUS
FIT-002 FITMENT_EVIDENCE_INSUFFICIENT
FIT-003 OPEN_FITMENT_DISPUTE
FIT-004 CONFIDENCE_STALE
UGC-001 CONTRIBUTOR_RIGHTS_GRANT_MISSING
UGC-002 PERSONAL_DATA_REVIEW_REQUIRED
UGC-003 OPEN_TAKEDOWN_OR_SAFETY_NOTICE
LINK-001 SOURCE_REMOVED_OR_RESTRICTED
```

## Editorial workflow

1. Normalize names and preserve original display values.
2. Resolve duplicate/collision candidates.
3. Check original landing page, creator, platform, licence, and rights state.
4. Record exact source claim and citation.
5. Resolve exact model, region, suffix, revision, and component/OEM relationship.
6. Run preliminary safety rules.
7. Separate sourced from editorial print settings.
8. Moderate each evidence item.
9. Recompute deterministic confidence.
10. Reviewer approves/rejects rights, safety, and publication.
11. Publish transaction re-checks all invariants.
12. Audit actor, reason, before/after, rulesets, and time.

Lifecycle:

`draft → in_review → published → needs_review → archived`

Archive instead of erasing to preserve evidence, auditability, and redirects.

## Notice and dispute response

Rights and safety notices are the highest priority. Record exact URL/content, reason, evidence, reporter contact, received/acknowledged/decision/action times, reason, and appeal status.

Operational target:

- Acknowledge promptly
- Place a credible high-severity safety claim on immediate hold
- Resolve ordinary disputes within two working days where evidence permits
- Explain the decision and retain the audit trail

## Ruleset changes

Fitment and safety evaluators have explicit versions (`fitment-v1`, `safety-v1`). A policy change requires:

1. Decision log entry
2. Test fixtures for old/new behavior
3. Migration/recomputation plan
4. Preview of every public status change
5. Reviewer approval
6. Batch recomputation with an audit report

The same evidence under the same ruleset must always produce the same result.
