# Decision log

Record meaningful product/architecture changes here before implementation.

| ID | Date | Decision | Reason | Revisit trigger |
| --- | --- | --- | --- | --- |
| D-001 | 2026-07-11 | Start with vacuum cleaners | Strong repair frequency and many low-risk external components | Phase 0 supply audit contradicts the assumption |
| D-002 | 2026-07-11 | Build a fitment index, not an STL host | Evidence/compatibility is the moat and linking reduces rights/liability exposure | Separate legal/product workstream approves hosting |
| D-003 | 2026-07-11 | Publish low-risk safety class only in v0 | Small team cannot responsibly review higher-risk uses at launch | Qualified safety review process exists |
| D-004 | 2026-07-11 | PostgreSQL search first | Exact identifiers and modest catalogue size do not justify another service | Measured p95/scale or feature need exceeds PostgreSQL |
| D-005 | 2026-07-11 | No public accounts or auto-public UGC | Reduces scope, abuse, privacy, and platform obligations | Contribution volume justifies accounts |
| D-006 | 2026-07-11 | Confidence labels are deterministic and evidence-backed | Avoid false precision and silent AI promotion | Versioned policy review with migration plan |
| D-007 | 2026-07-11 | Single Next.js TypeScript application | Smallest deployable architecture for one owner and agent builders | Team/scale creates a measured boundary |
| D-008 | 2026-07-11 | Use the committed npm lockfile, support Node.js 22+, and run the complete gate on Node.js 24 in CI | Reproducible installs plus coverage of the declared minimum locally and the CI runtime remotely | A dependency or hosting runtime requires a different supported range |
| D-009 | 2026-07-11 | Demo indexing fails closed unless `DEMO_MODE` is exactly `false` | Fictional records must never become crawlable because an environment variable is missing or mistyped | The full release checklist has named evidence and approves public mode |
| D-010 | 2026-07-11 | Do not invent repository, hosting, database, URL, owner, or credential values to make WP-00 appear provisioned | External controls must be auditable facts; unknowns remain explicit blockers in the environment inventory | The product owner provisions or supplies access to the selected providers |
| D-011 | 2026-07-11 | Use the public GitHub repository `cntlouie/repairprint-index` as the production source remote, without adding a license | The owner explicitly authorized public visibility so the free personal-account repository can enforce the required `main` protection rule; public visibility exposes the fictional builder pack but grants no reuse license | Repository ownership, account tier, licensing, or hosting policy changes |
| D-012 | 2026-07-11 | Use Vercel Hobby project `repairprint-index` for WP-00 demo and pull-request deployments with `DEMO_MODE=true` in Production and Preview | Matches the documented Next.js deployment target and provides automatic branch previews without enabling launch indexing | Hosting requirements, pricing, or measured runtime needs change |
| D-013 | 2026-07-11 | Run the WP-01 zero-state migration and idempotent-seed gate against PostgreSQL 17 as a GitHub Actions service | Gives every pull request an isolated real-PostgreSQL database without storing a shared database credential or risking staging data | PostgreSQL support policy or CI platform changes |
| D-014 | 2026-07-11 | Keep Supabase as the preferred managed PostgreSQL provider, but require explicit approval before selecting a paid backup tier or encrypted off-site backup service | Supabase Free does not provide the automatic daily backups WP-01 requires; the project must not silently incur recurring cost or falsely claim backups | The owner selects a backup option or a different managed PostgreSQL provider |
| D-015 | 2026-07-11 | Use Supabase Free for WP-01 staging with a daily client-side encrypted logical backup retained as a GitHub Actions artifact for 30 days | The owner selected the zero-cost option; encryption occurs before the dump leaves the runner, the recovery passphrase is stored as a GitHub Actions secret and as a Windows DPAPI-protected owner copy, and no paid add-on is enabled | Staging exceeds Free limits, recovery requirements increase, key custody moves to an organization vault, or the provider plan changes |
| D-016 | 2026-07-11 | Activate `domain-rules-v1` with `fitment-v1` and `safety-v1` as pure deterministic evaluators | Compatibility, safety, collision, and publication judgments must be reviewable, reproducible, and isolated from commercial metadata or machine authority | A reviewed policy change includes old/new fixtures, a public-status preview, reviewer approval, and an idempotent recomputation plan |
| D-017 | 2026-07-11 | Use Supabase Auth Free for invite-only staff identity, with database-owned roles and AAL2 enforcement for reviewer/admin | Reuses the managed staging provider without paid features while keeping authorization server-side and independent of client claims | Auth limits, provider policy, organization SSO, or measured operational needs require another identity provider |
| D-018 | 2026-07-11 | Commit CSV imports only to a private checksummed candidate queue; canonical/public records require a later editorial action | Preserves provenance, makes retries idempotent, prevents import/AI authority from becoming verification, and retains ambiguous model/OEM collisions for human review | A reviewed workflow demonstrates equally strong provenance, idempotency, audit, ambiguity, and publication separation |
| D-019 | 2026-07-11 | Use a bounded submission-to-publication case workflow instead of exposing a generic database admin | Gives non-developers source-side context and deterministic transitions while preventing arbitrary table mutation, self-review, and accidental publication | Editorial volume or new record types require a reviewed extension that preserves per-action authorization and audit contracts |
| D-020 | 2026-07-12 | Protect anonymous contributions with exact-origin checks, server-side Turnstile, durable database rate buckets, versioned consent, pseudonymous actor-scoped semantic deduplication, and dormant email follow-up hooks | Contains abuse across serverless instances without storing raw network addresses; collapses retries/duplicates without collapsing independent contributors or punctuation-distinct exact models; consent alone must never schedule an email or publish content | Counsel changes consent/retention wording, a provider changes validation semantics, measured abuse changes rate policy, or accounts replace anonymous identity |

## WP-00 deviations and resolved blockers

- The builder pack arrived inside a parent Git repository. WP-00 initializes this
  folder as its own repository so project commands cannot traverse into the user
  profile.
- The remote repository exists and its initial `main` CI run passed. The owner
  authorized changing it from private to public so GitHub could enforce the
  required classic protection rule on the personal account. The enforced rule
  now applies to `main` and requires the GitHub Actions `verify` check. The
  Vercel demo is crawler-blocked, and the pull-request preview is protected by
  Vercel Authentication with app-level `noindex`. No WP-00 blocker remains.

## Template

```text
ID:
Date:
Decision:
Options considered:
Reason:
Consequences:
Revisit trigger:
Owner:
```
