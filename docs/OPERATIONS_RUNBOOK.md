# Minimal operations runbook

Fill in real contacts and provider commands before launch.

## Ownership

```text
Primary operator:
Backup operator:
Safety/rights inbox:
Security inbox:
Database provider:
Hosting provider:
Object storage:
Error monitoring:
Analytics:
Status page:
```

## Private aggregate analytics (not enabled)

WP-11 provisions no analytics provider, credential, scheduler, reporting role,
retention horizon, or cleanup job. Keep `ANALYTICS_MODE=disabled` and
`ANALYTICS_DATABASE_URL` empty in preview and staging. Production collection
must remain disabled until product/privacy owners approve the bounded event
contract and retention horizon, and operations records an owner, cleanup
procedure, and dedicated `repairprint_analytics_service` credential.

The private report requires a different, read-only reporting credential with
only the approved aggregate-table access. Do not use an application runtime,
database-owner, anonymous/authenticated, submission/source service, or
`repairprint_analytics_service` credential. The script accepts that reporting
credential only through its process-scoped `DATABASE_URL`; do not add it to the
web deployment environment. After the role is reviewed and provisioned, run:

```bash
DATABASE_URL="$ANALYTICS_REPORT_DATABASE_URL" npm run analytics:report -- --days=30 --minimum-cell-count=5
```

`ANALYTICS_REPORT_DATABASE_URL` above is an operator-shell placeholder, not a
repository or deployed application variable. Treat the JSON output as private
operational material: keep the minimum cell count at five or higher, do not
publish it or paste it into issues/PRs, and do not join it to submissions,
contacts, media, network logs, or other identity-bearing data. The report
combines the selected window and exposes no raw or per-day event rows.

No retention deletion is authorized by WP-11. Enabling collection therefore
also requires a reviewed forward migration or equally reviewed bounded cleanup
mechanism implementing the approved horizon. Analytics failure is best effort
and must never change search ranking, fitment, safety, publication, moderation,
or a visitor's journey.

## Wrong-model or unsafe recommendation

1. Immediately set affected fitment/page to `needs_review` and remove it from search/sitemap/cache.
2. Preserve the triggering report and current page snapshot privately.
3. Identify every model/design/component edge sharing the evidence or source.
4. Acknowledge the reporter.
5. Reviewer classifies fit failure, model ambiguity, design revision change, or safety incident.
6. Correct, dispute, reject, or archive with an audit reason.
7. Recompute dependent confidence and refresh search documents.
8. If users may have acted on a dangerous claim, obtain legal/safety guidance on broader notification.

## Rights/takedown notice

1. Acknowledge and record exact URL, claimant, basis, evidence, and time.
2. Place the design/source record on hold if credible or urgent.
3. Verify source, creator, licence state, and original-upload evidence.
4. Decide objectively and record reasons/action/appeal route.
5. Remove copied media immediately when rights cannot be shown; v0 should have no mirrored design files.
6. Recheck any duplicate/cross-posted records.

## Broken or changed source

1. Link job records response, redirect and the bounded landing-page checksum.
2. Move affected records to `needs_review` when the landing page is gone, restricted, materially redirected, or its checksum changes. A human then reviews revision and licence/rights facts; automation never decides that a rights change is acceptable.
3. Do not transfer old fit evidence to a new design revision automatically.
4. Update, archive, or replace the source; retain redirect/audit history.

WP-10 supplies `npm run sources:links` as a bounded external-scheduler entry
point, but configures no scheduler or credential. Before enabling it, provision
the exact `repairprint_source_service` credential, a separate 64-hex scheduler
secret, an active machine-attribution staff UUID and a unique worker label. A
batch claims at most eight rows for 120
seconds, checks at most four concurrently, and uses database time. A terminated
process leaves the lease reclaimable. Never run the worker with an owner URL or
derive an allowlist from a stored source URL.

404/410, 401/403/451, material redirects and checksum changes withdraw supported dependent published
records atomically. Every other HTTP status has a retryable completion path;
timeout, DNS, other 4xx, 429 and 5xx observations release their lease and are
rescheduled. Retry-After is clamped to one minute through 24 hours.
Review the immutable observation and audit event before updating a source or
rights decision; the monitor never renews policy or rights.
The application invalidates all affected catalogue/model/part tags only after
link completion commits. A cache failure returns a sanitized 503 with committed
state and retry tags; it never claims the database transaction rolled back.

## Credential exposure

1. Revoke/rotate the credential immediately.
2. Check provider audit logs and affected data scope.
3. Redeploy from a known clean commit/secrets set.
4. Notify affected parties/authorities where required after qualified advice.
5. Record incident timeline and prevention change.

## Database restore

Quarterly before scale, then on the agreed schedule:

1. Restore the latest backup into an isolated environment.
2. Run migration status, foreign-key/invariant audit, and fixed search corpus.
3. Compare row counts and sampled source/evidence chains.
4. Record recovery point/time achieved and failures.
5. Never point a restore test at production storage or web traffic.

## Release rollback

- Application-only failure: redeploy the last green immutable build.
- Additive migration failure: stop writes, correct forward where safe.
- Destructive/data migration: follow the reviewed migration-specific recovery plan; do not improvise a rollback after production writes.
- Ruleset regression: unpublish affected changed records, restore prior ruleset for display, and run a reviewed recomputation.

Every incident/action needs an owner, request/incident ID, timestamps, evidence, decision reason, and follow-up.

## Private media storage and cleanup

Keep demo mode enabled until every media policy version/duration, both private
bucket names and the separate capability key are configured. `npm run
media:storage` checks privacy, MIME and size controls; `-- --apply` is an
authorized provisioning action and refuses demo mode. `npm run media:cleanup`
claims a bounded database-clock batch with `SKIP LOCKED`, deletes quarantine
and processed objects first, then deletes database rows. Any storage failure
must preserve rows for retry after the lease expires.
