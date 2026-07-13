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

1. Link job records response/redirect/checksum change.
2. Move affected record to `needs_review` when the landing page is gone, restricted, materially revised, or licence changed.
3. Do not transfer old fit evidence to a new design revision automatically.
4. Update, archive, or replace the source; retain redirect/audit history.

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
