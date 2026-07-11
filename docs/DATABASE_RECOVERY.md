# Database migration, backup, and restore notes

## Connections

- Runtime uses a transaction-pooled `DATABASE_URL` with prepared statements
  disabled.
- Migrations, logical backups, and restores use a direct
  `DATABASE_DIRECT_URL` when the managed provider requires it.
- Both values are server-only encrypted environment settings. Neither belongs
  in Vercel client variables, source control, logs, or preview comments.

## Initial migration

Migration `0000_curvy_shinko_yamashiro` is additive on an empty database. It
creates `pg_trgm`, nine enums, and 22 tables with their indexes and foreign keys.

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

## Automated backup requirement

Supabase currently provides automatic daily backups on Pro, Team, and
Enterprise plans. Supabase recommends regular off-site logical exports for Free
projects. WP-01 therefore requires one explicitly selected configuration:

1. Supabase Pro staging with provider-managed daily backups and seven-day
   retention; or
2. Supabase Free staging plus an encrypted scheduled logical export to private
   off-site storage with tested key custody and retention.

The project must not claim automated backups until one option is provisioned
and observed. PITR is not required for v0 staging and must not be enabled without
explicit cost approval.

## Restore drill

Use a real backup, never the live staging or production database:

1. Create an isolated restore project/database with no application traffic.
2. Restore the selected provider backup or decrypt and load the logical dump.
3. Run `npm run db:migrate` to verify migration state.
4. Run foreign-key validation, table/row counts, and the publication invariant
   audit available at that work-package stage.
5. Sample the model → component → fitment → evidence → source chain.
6. Record backup timestamp, restore start/end, achieved RPO/RTO, row counts,
   operator, failures, and deletion of the isolated restore environment.

WP-01 is accepted only after this drill is performed against the provisioned
managed staging backup and its evidence is added below.

## Restore evidence

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
