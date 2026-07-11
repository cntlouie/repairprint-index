# Domain ruleset migration and recomputation

## Current package

- Package: `domain-rules-v1`
- Fitment evaluator: `fitment-v1`
- Safety evaluator: `safety-v1`
- Effective date: 2026-07-11

The package contains pure identifier, fitment, safety, and publication
decisions under `src/domain/`. The same normalized input and ruleset version
must produce byte-for-byte equivalent decisions. Affiliate value, sponsorship,
advertising, and machine suggestions are not evaluator inputs.

## Initial activation

WP-02 formalizes the versions already reserved by the WP-01 schema defaults.
There are no public records to migrate: staging contains one explicitly
fictional draft fitment and the restore audit confirmed zero published
fitments. Before activation, recompute all draft fitments and safety reviews,
store their version and decision, and compare the output with the fixture
expectations. Any unexpected status change stays in review.

## Required process for a later version

1. Add a decision-log entry before changing policy.
2. Keep the previous evaluator available during the migration window.
3. Add table-driven fixtures that show old and new behavior.
4. Recompute into a preview without changing public state.
5. Produce an audit report listing every changed label, safety class, reason,
   and publication outcome.
6. Obtain reviewer approval for the rules and the preview.
7. Apply the new version in a resumable, idempotent batch.
8. Re-run the publication gate and move newly ineligible records to
   `needs_review` before refreshing public caches or search documents.

Rollback restores the previous stored ruleset decisions and versions from the
audit report, reruns publication checks, and leaves affected records
unpublished until a reviewer confirms the rollback result. Evidence is never
deleted or moved between design revisions during recomputation.
