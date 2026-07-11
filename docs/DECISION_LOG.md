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

## WP-00 deviations and blockers

- The builder pack arrived inside a parent Git repository. WP-00 initializes this
  folder as its own repository so project commands cannot traverse into the user
  profile.
- No remote repository, protected branch, hosting project, or staging URL was
  available when WP-00 began. Their current status and required controls are
  recorded in `docs/ENVIRONMENT_INVENTORY.md`; WP-00 cannot be accepted until
  those external controls are provisioned and verified.

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
