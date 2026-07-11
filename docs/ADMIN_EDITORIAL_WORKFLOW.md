# Admin editorial workflow

WP-05 provides one private staff workspace at `/admin`. It is an editorial
case workflow, not a public account system and not a generic database console.
The page and every admin response are `noindex`, private, and non-cacheable.

The catalog-draft panel lets an editor create one exact model identifier,
component mapping, and optional OEM reference from an existing reviewed source.
It preserves display values alongside strict/loose keys, rejects brand-scoped
identifier or OEM collisions, creates only draft/pending records and citations,
and writes `catalog.target.prepare` to the immutable audit log. It never merges
ambiguous models and cannot publish the draft.

## Authentication

The browser uses only the Supabase project URL and publishable key. Staff sign
in with an invited email/password account. The client can enroll or challenge
a TOTP authenticator, then forwards the access token as a bearer token to
`/api/admin`.

An invitation redirects to the production `/admin` page with an authenticated
one-time session. Before signing out, the invited staff member sets a password
in the workspace and enrolls a TOTP authenticator. The browser uses
`auth.updateUser` for the signed-in password change; no password is sent to a
RepairPrint application endpoint or stored in the application database.

Every API request independently verifies the ES256 JWT and loads the active
database-owned staff role. Editors use AAL1 to prepare drafts. Every
reviewer/admin request requires AAL2. The browser never receives the service
role key and client claims never define authorization.

## Creator-link journey

1. A public design-link submission enters `submissions` as `pending`.
2. An editor selects one exact existing product component. The model identifier
   must strictly match the submitted display value; suffixes and regions are
   not inferred.
3. The editor records the original landing page, creator, source platform and
   external ID, exact source revision, observed licence state, attribution,
   file-format metadata, and exact-model creator claim.
4. One transaction creates draft source/design/revision/fitment/evidence/
   citation records, moves the submission to `in_review`, and writes the audit
   event. No URL is fetched and nothing is published.
5. A different reviewer sees the source beside the material claim. The
   reviewer accepts or rejects evidence/rights/safety with a reason. Self-review
   is rejected.
6. Acceptance recomputes deterministic fit confidence. A creator claim can
   become `creator_listed`; it never becomes verified fit.
7. Publication is a separate AAL2 transaction. It re-checks source policy and
   health, attribution/licence, exact target, accepted provenance, low safety,
   open notices/disputes, current revision, and active fitment/safety rulesets.
8. Passing publication updates the fitment, design, exact model, and brand and
   resolves the submission. A blocked gate returns its deterministic codes.
9. Rejection retains the prepared records as private drafts together with the
   rejected submission and audit history; only an admin may archive records.

## Disputes and archive

Accepting one exact-model `does_not_fit` report recomputes the edge. When it
conflicts with accepted positive evidence, the fitment becomes `disputed` and
a published record immediately moves to `needs_review`, removing it from the
published-only view.

Admins may archive a fitment with a different internal replacement path. The
fitment and evidence remain stored, one `slug_history` redirect is written,
and redirect chains are rejected. Production part routes consult this record;
demo mode remains on the fictional synchronous catalogue.

## Admin endpoints

| Endpoint | Action | Role |
| --- | --- | --- |
| `GET /api/admin/queue` | Private submissions, exact targets, collisions | editor+ |
| `POST /api/admin/catalog/targets` | Create sourced exact model/component/OEM draft | editor+ |
| `POST /api/admin/cases/:id/prepare` | Create sourced draft case | editor+ |
| `GET /api/admin/cases/:id/preview` | Source-side claim preview | editor+ |
| `POST /api/admin/cases/:id/review` | Accept/reject evidence, rights and safety | reviewer+ AAL2 |
| `POST /api/admin/cases/:id/publish` | Atomic publication recheck | reviewer+ AAL2 |
| `POST /api/admin/evidence/:id` | Moderate and recompute fitment/dispute | reviewer+ AAL2 |
| `POST /api/admin/fitments/:id/archive` | Archive and write redirect | admin AAL2 |

Every write requires a non-empty reason and request ID and writes one immutable
audit event with before/after state.

## Verification and recovery

The PostgreSQL fresh-database gate creates a sourced exact catalog draft and
runs both branches of the creator journey with fictional records: prepare → independent accept → publish → incompatibility
dispute → archive/redirect, plus prepare → reject. It verifies published-view
entry/removal, retained evidence, transition audit count, and self-review
rejection.

The 2026-07-11 Vercel preview verification confirmed that `/admin` renders the
invite-only sign-in form with the configured browser-safe Supabase URL/key and
retains `noindex, nofollow, nocache`. `DEMO_MODE` remained enabled.

WP-05 adds no tables and no migration. Recovery is forward-only: disable the
staff profile or admin route, correct the application, and retain all existing
audit/evidence/submission/redirect rows. Never “rollback” by deleting history.
