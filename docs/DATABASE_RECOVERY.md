# Database migration, backup, and restore notes

## Connections

- Runtime uses a transaction-pooled `DATABASE_URL` with prepared statements
  disabled.
- Migrations use a direct `DATABASE_DIRECT_URL` when reachable, or the
  provider's session-pooler endpoint as the IPv4-compatible fallback. Logical
  backups and restores still require a connection mode supported by `pg_dump`
  and `pg_restore`.
- Both values are server-only encrypted environment settings. Neither belongs
  in Vercel client variables, source control, logs, or preview comments.

## Migration set

Migrations `0000_curvy_shinko_yamashiro`, `0001_fixed_jack_murdock`,
`0002_dizzy_magik`, `0003_production_search`, `0004_repair_search_view`, and
`0005_production_public_catalogue`
apply from zero. Together they
create `pg_trgm`, fifteen enums, 26 tables, four published-only entity views,
two publication-filtered catalogue views, the denormalized public search view,
and their indexes and foreign keys.
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
Because `0005` remained unmerged and had not reached controlled staging during
WP-07 correction, its eligibility, provenance, canonical-selection, indexes,
grants, and migration snapshot were corrected in place. Migrations `0000`
through `0004` remain byte-for-byte unchanged. Once `0005` reaches a controlled
database, every further correction must use a new forward migration.

Apply to staging only after a successful fresh-database gate:

```bash
DATABASE_URL="$DATABASE_DIRECT_URL" npm run db:migrate
npm run db:seed
```

The seed is fictional, remains in draft, uses stable fixture UUIDs, and is safe
to run repeatedly.

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

The reusable template remains below for the next drill.

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
