# Database migration, backup, and restore notes

## Connections

- Runtime uses a transaction-pooled `DATABASE_URL` with prepared statements
  disabled.
- Private submission intake, bounded cleanup, qualifying-event creation, and
  authorized evidence lookup use a separately credentialed
  `SUBMISSION_DATABASE_URL`; the runtime verifies that connection is exactly
  `repairprint_submission_service` before use.
- Migrations use a direct `DATABASE_DIRECT_URL` when reachable, or the
  provider's session-pooler endpoint as the IPv4-compatible fallback. Logical
  backups and restores still require a connection mode supported by `pg_dump`
  and `pg_restore`.
- Both values are server-only encrypted environment settings. Neither belongs
  in Vercel client variables, source control, logs, or preview comments.

## Migration set

Migrations `0000_curvy_shinko_yamashiro` through
`0012_eager_earthquake` apply from zero. The current fresh-database gate expects
44 tables in the `public` schema together with the reviewed views, functions,
indexes, constraints, triggers, and role boundaries. The 31-table count for the
set through `0006_anonymous_contributions` remains historical WP-08 context,
not the current schema count.

Migration `0002` is additive and introduces only the private import run, row,
and collision queue tables; its recovery procedure is in `docs/CSV_IMPORTS.md`.
Migration `0003` is a read-only view and may be rolled back by dropping
`public_search_documents`; doing so disables production search without changing
source records.
Migration `0004` replaces that materialized view forward, recreates its indexes
and grants, and corrects the part-subtitle delimiter. If it fails, leave search
disabled or rerun the reviewed `0004` definition; never edit the already-applied
`0003` migration. Neither migration mutates source records.
Migration `0005` adds the production catalogue and unavailable-source views,
then replaces the materialized search view so both surfaces use the same
eligibility boundary. It is data-preserving. If application rollout must be
reversed, leave the views in place; they are compatible with older readers. If
the migration itself fails before commit, drop the partially created search
materialized view and catalogue views, then restore the reviewed `0004` search
view definition before retrying a corrected forward migration. Never expose
base tables or relax the catalogue filters as a recovery shortcut.
Migration `0006` is additive. It separates the semantic moderation parent from
complete immutable accepted intakes, stores optional email in an independently
expiring contact child, adds stable opaque receipts, durable rate buckets, and
intake-scoped typed follow-up work. It also adds the private singleton HMAC key
commitment and creates least-privilege `repairprint_submission_service` and
no-login `repairprint_submission_maintenance` roles. Consent alone creates no
follow-up row, and WP-08 adds no provider, worker or sender. The migration does
not add or broaden a public view. Its legacy-compatible version-zero default
never invents consent; after version-one writes, recover only with a reviewed
forward fix.
Because `0005` remained unmerged and had not reached controlled staging during
WP-07 correction, its eligibility, provenance, canonical-selection, indexes,
grants, and migration snapshot were corrected in place. Migrations `0000`
through `0004` remain byte-for-byte unchanged. Once `0005` reaches a controlled
database, every further correction must use a new forward migration.

Apply to staging only after a successful fresh-database gate:

```bash
DATABASE_URL="$DATABASE_DIRECT_URL" npm run db:migrate
npm run db:seed
# With a securely generated SUBMISSION_HMAC_SECRET already present:
DEMO_MODE=false DATABASE_URL="$DATABASE_DIRECT_URL" npm run submissions:key-pin
```

The seed is fictional, remains in draft, uses stable fixture UUIDs, and is safe
to run repeatedly. Key-pin provisioning requires migration/admin credentials,
not `SUBMISSION_DATABASE_URL`. It stores only a purpose-separated commitment.
Re-running it with the same key/version is a no-op; a mismatch fails closed.

## Failure and recovery

- Before application writes: discard the failed empty database, correct the
  migration forward, and rerun the zero-state test. Do not edit a migration
  that has been accepted on a persistent environment without a replacement
  migration and decision record.
- After staging writes: stop writers, take a logical backup, diagnose migration
  state, and prefer a reviewed forward correction. Restore into a separate
  project/database before any destructive recovery.
- After production writes: no automatic down migration is authorized. Follow
  the incident runbook, preserve evidence, and restore or correct forward only
  from a reviewed plan.
- A restored database retains its HMAC key pin. Restore the original
  `SUBMISSION_HMAC_SECRET` before resuming intake. A missing or mismatched key
  returns a sanitized 503 before rate identities, binding lookup, semantic
  deduplication, or writes. Do not replace the pin while retained private rows
  exist; seamless live-key rotation is intentionally unsupported in WP-08 and
  requires a future reviewed keyring/rekey package.

## Automated backup configuration

Supabase currently provides automatic daily backups on Pro, Team, and
Enterprise plans. Supabase recommends regular off-site logical exports for Free
projects. WP-01 therefore requires one explicitly selected configuration:

1. Supabase Pro staging with provider-managed daily backups and seven-day
   retention; or
2. Supabase Free staging plus an encrypted scheduled logical export to private
   off-site storage with tested key custody and retention.

The owner selected option 2 on 2026-07-11. Supabase Free staging project
`repairprint-index-staging` (`inscdebgwdzubyzfifkd`) is provisioned in West EU
(Ireland) with the public Data API disabled. No paid backup or PITR add-on is
enabled.

`.github/workflows/database-backup.yml` runs daily at 03:17 UTC after it lands
on the default branch. It dumps the application `public` schema plus the
`drizzle` migration ledger, encrypts the dump with GPG AES-256 before upload,
stores only the encrypted dump and its checksum as a GitHub Actions artifact,
and retains it for 30 days. The workflow requires repository secrets
`STAGING_DATABASE_DIRECT_URL` and
`BACKUP_ENCRYPTION_PASSPHRASE`.

The recovery passphrase has two copies: the GitHub Actions secret used by the
runner and a Windows DPAPI-protected owner copy at
`%USERPROFILE%\\.repairprint-index\\backup-recovery-key.dpapi`. The protected
copy is outside this repository and readable only by the current Windows user.
It must be moved to an organization password manager before production. Never
commit, print, or paste the decrypted value into logs or issue comments.

The workflow produced and retained a real encrypted artifact during the WP-01
drill below. Its daily schedule becomes active when this workflow lands on the
default branch. PITR is not required for v0 staging and must not be enabled
without explicit cost approval.

## Restore drill

Use a real backup, never the live staging or production database:

1. Create an isolated restore project/database with no application traffic.
2. Restore the selected provider backup or decrypt and load the logical dump.
3. Run `npm run db:migrate` to verify migration state.
4. Run foreign-key validation, table/row counts, and the publication invariant
   audit available at that work-package stage.
5. Sample the model → component → fitment → evidence → source chain.
6. Verify the four `published_*` views expose no draft records and confirm an
   attempted audit-row update/delete is rejected as append-only.
6. Record backup timestamp, restore start/end, achieved RPO/RTO, row counts,
   operator, failures, and deletion of the isolated restore environment.

WP-01 is accepted only after this drill is performed against the provisioned
managed staging backup and its evidence is added below.

## Restore evidence

```text
Provider/project: Supabase Free / repairprint-index-staging (inscdebgwdzubyzfifkd), West EU (Ireland)
Backup type and timestamp: public + drizzle logical custom dump, GPG AES-256 encrypted; 2026-07-11T20:55:32Z
Backup artifact: repairprint-staging-29167872754-1; retained 30 days; artifact id 8252677614
Backup artifact digest: sha256:9ce30dc2f9325d699c5732d809243fe05e75e1c0cbd0e04012fb043ac953e757
Restore target: isolated Supabase Free project rxscjnovwgyndgeruapj
Operator: GitHub Actions run 29167872754, initiated by repository owner cntlouie
Started: 2026-07-11T20:54:53Z
Completed: 2026-07-11T20:55:57Z
Achieved RPO: no known data loss; the deterministic staging seed completed immediately before the logical dump
Achieved RTO: 23 seconds from encrypted artifact creation to passed restore verification; 64 seconds for the complete run
Migration status: tracked Drizzle ledger restored; npm run db:migrate passed after restore
Row/invariant checks: 26 public tables; 1 fitment; 1 evidence; 1 source; 0 published fitments
Source/evidence sample: deterministic model -> component -> fitment -> evidence -> source fixture counts passed
Restore target deleted: yes, 2026-07-11 after evidence capture
Temporary RESTORE_DATABASE_URL secret deleted: yes
Result: passed
Evidence: https://github.com/cntlouie/repairprint-index/actions/runs/29167872754
```

The 26-table count above is immutable historical WP-01 evidence. After
`0006_anonymous_contributions`, a fresh or restored current database must have
31 base tables. Before applying `0006` to a database with writes, record
submission counts by kind/status and count version-zero payloads containing a
non-empty legacy `email`. Do not infer consent or create follow-up work for
legacy rows; a non-zero legacy-email count requires an explicit privacy and
retention disposition. Take a logical backup before staging migration.

Recovery for `0006` is forward-only after contribution writes. Verify the
semantic-parent and immutable-intake consent/challenge/retention constraints;
the unique receipt and canonical actor/UUID scope; the composite
parent/version/receipt relationship; active contributor-content and intake
deadline indexes; complete contact-present intakes; intake-scoped follow-up
constraints; valid rate buckets; and the singleton key commitment. Audit for
zero orphan semantic parents, intakes, contacts or follow-ups and zero
kind/version/receipt mismatch. Prove that the service role cannot update,
truncate or directly delete an intake/contact, cannot mutate the pin, and can
execute only the bounded cleanup function for retention deletion. Prove that
the function owner is the separate non-login maintenance role, neither role is
privileged or a role member, and `PUBLIC`, `anon`, and `authenticated` have no
private-table or cleanup-function access. Confirm migrations 0000-0005 remain
byte-for-byte unchanged. If application rollback is temporarily required, stop
version-one intake first: key-pin, retention and named-role configuration
intentionally fail closed. No legacy row gains inferred consent, and no
destructive down migration is authorized.

The deployment operator must restore the original pinned HMAC key, configured
retention policy version and reviewed submission/contact durations, then resume
the externally scheduled `npm run submissions:cleanup` monitor. Cleanup accepts
only a batch size from 1 to 1000, uses database time internally, and reports
deleted contact, follow-up, intake, and semantic-parent counts. It must be safe
to repeat and race, must preserve a semantic parent/receipt while any later
intake remains, and must never rewrite accepted snapshots, write catalogue
records, or create follow-up work.

An explicit owner/admin pin replacement uses:

```bash
DEMO_MODE=false DATABASE_URL="$DATABASE_DIRECT_URL" npm run submissions:key-pin -- --replace
```

It is permitted only after the script proves there are no version-one semantic
parents, immutable intakes, contacts, follow-ups, or rate buckets. This is an
empty-state maintenance operation, not live rotation. Runtime rate/intake
transactions lock and recheck the pin through commit; the maintenance command
locks the pin and dependent write tables before its zero-state decision. An
in-flight old-key write therefore drains and makes replacement refuse, or waits
and then fails against the replacement pin.

The reusable template remains below for the next drill.

Migration `0007` is additive and forward-only after media writes. Restore both
private buckets before media review and never copy contributor media to a
preview. Recheck bucket privacy and media-table/function revocations. Reconcile
object checksums before cleanup resumes. Cleanup is deletion-first: uncertain
object deletion preserves the database row and is retried.

Migration `0008` adds the private pending-object deletion manifest. Restore it
with the other private media tables. Before resuming intake, reconcile every
manifest path against the private bucket, run `npm run media:cleanup`, and
confirm both the manifest and raw-quarantine pending sets drain. A manifest is
created before storage upload and removed only in the transaction that commits
the derivative, so it must never be discarded merely because an object is
missing; deletion of a missing object is an idempotent successful recovery.

Migration `0009` is additive but its policy and link observations are
evidentiary. Restore `source_policy_reviews`, candidates/versions, adapter runs,
link jobs and checks together. Do not manufacture a current policy row if its
immutable reviewer snapshot is missing. Before resuming a worker, verify the
migration ledger hash, both source roles and their function-only boundary,
append-only triggers, current policy/snapshot agreement, and that no link job
has an active lease from the restore cutoff. Expired leases are reclaimed with
database time; do not delete them. Re-run the publication/search audit before
serving catalogue traffic because confirmed removal may have withdrawn
dependent records in the same committed transaction.

Migration `0010` is a forward corrective source-boundary migration. Restore
`source_candidate_acquisitions`, policy-review and adapter-run provenance,
policy terms checksums, and source-link content checksums together; none may be
reconstructed from a later candidate payload. Keep source automation disabled
after a restore until `npm run db:ledger:check`, the fresh role/function audit,
and the publication/search audit pass. If the migration or an older application
rollout fails, stop source workers and correct forward; do not drop the
acquisition evidence table or restore the broader function signatures.

Migration `0011` repairs ownership-context ACLs on the four WP-10 source
functions and changes no source data. Recovery must reapply the migration
forward and prove that only `repairprint_source_service` can execute the exact
allowlist, its no-login maintenance owner still owns the functions, and
`PUBLIC`, `anon`, and `authenticated` have no execute access. Do not grant a
table privilege or a temporary public function grant to resume a worker.

Migration `0012` is additive and forward-only once aggregate counts exist. It
adds only bounded UTC-day analytics counters plus the execute-only
`repairprint_analytics_service` and no-login
`repairprint_analytics_maintenance` boundary; it adds no raw-event table or
anonymous view. Restore the aggregate table, recorder function, ownership, and
ACLs as one unit, then rerun the fresh database and role/privacy gates. Keep
`ANALYTICS_MODE=disabled` and do not provision the service or reporting
credentials after recovery until product/privacy owners approve retention and
operations provides a cleanup procedure. A failed application rollout can
leave this private additive schema in place. Never recover by granting the
service direct table access, manufacturing missing counts, or adding a
destructive down migration.

```text
Provider/project:
Backup type and timestamp:
Restore target:
Operator:
Started:
Completed:
Achieved RPO:
Achieved RTO:
Migration status:
Row/invariant checks:
Source/evidence sample:
Restore target deleted:
Result:
```
