# Acceptance tests and release checklist

`DEMO_MODE=false` is a release privilege, not an ordinary environment change. Every section below must have named evidence and an owner.

## Automated code gate

```bash
npm run typecheck
npm run lint
npm run test
npm run content:check
npm run build
```

Before launch, CI must additionally run fresh-database migrations, database integration/RLS tests, Playwright critical paths, accessibility scans, publication invariant audit, and sitemap/canonical audit.

## Domain rules

- [ ] Strict/loose normalization retains leading zeros and suffix distinctions
- [ ] Loose-key collision within brand produces `MODEL_AMBIGUOUS`
- [ ] Trusted exact-revision test yields Verified when no credible negative exists
- [ ] Two distinct accepted exact successes + installed photo yield Community Confirmed
- [ ] Same actor cannot manufacture independence through reposts
- [ ] Creator exact claim yields Creator Listed only
- [ ] OEM/dimension/AI-only evidence stays Candidate
- [ ] Accepted exact incompatibility opens Disputed/Rejected
- [ ] Print failure does not count as incompatibility
- [ ] Evidence stays on the tested design revision
- [ ] Same evidence + ruleset yields identical output

## Safety/publication

- [ ] Every blocked safety signal prevents publication
- [ ] Caution stays private in v0
- [ ] Fitment label is never rendered as a safety guarantee
- [ ] Missing source, creator, licence state, target, rights date, or safety review blocks publication
- [ ] Blocked/stale platform policy blocks ingestion/publication
- [ ] Open rights/safety notice places the record on hold
- [ ] Stale confidence/safety ruleset blocks publication
- [ ] Affiliate/sponsored metadata cannot alter confidence rank

## Fixed search corpus

Maintain at least 100 versioned queries with expected entity and ambiguity behavior.

- [ ] ≥95% exact model/OEM expected entity ranks first
- [ ] 100% ambiguous variants require disambiguation
- [ ] No meaningful leading zero is lost
- [ ] Model + component queries land on the correct physical part
- [ ] Common typos/synonyms meet agreed results
- [ ] Unknown query offers a private missing-part path
- [ ] Candidate/blocked/unpublished records never appear as recommended results
- [ ] p95 search latency <300 ms at launch data volume

## Public journeys

- [ ] Home search → exact model → component → source works on mobile/desktop
- [ ] OEM number search resolves component and cited exact models
- [ ] Variant chooser never preselects silently
- [ ] Source link displays creator, licence state, revision, and last check
- [ ] Fit report records five outcomes distinctly
- [ ] Missing-part and design-link submissions enter private queues
- [ ] No anonymous submission auto-publishes
- [ ] Removed design source produces a clear unavailable state and alternative path
- [ ] Old slugs redirect once and self-canonicalize at destination

## Admin journeys

- [ ] Self-service staff signup disabled
- [ ] Reviewer/admin MFA enforced
- [ ] Editor can prepare but not publish
- [ ] Reviewer can see source beside each material claim
- [ ] Safety/rights/fitment decisions require a reason
- [ ] Fit dispute can immediately remove recommendation/index eligibility
- [ ] Every transition records actor, time, reason, before/after, and request ID
- [ ] Archive retains evidence/history and creates redirect where appropriate

## Data and imports

- [ ] Twenty representative Phase 0 records round-trip through CSV import/export
- [ ] Dry run produces insert/update/unchanged/reject counts and row errors
- [ ] Commit requires the same input checksum as dry run
- [ ] Re-running an import is idempotent
- [ ] Duplicate external URL/revision is blocked
- [ ] Model/OEM collisions enter review rather than merge
- [ ] Supersession cycles are rejected
- [ ] Fresh database migrates from zero and seeds successfully
- [ ] Restore drill completes from a real backup

## Rights/privacy/security

- [ ] No mirrored design files or repository images
- [ ] Every design has original landing page, creator, licence state, rights check, and source dates
- [ ] Source adapters run only under current enabled policies
- [ ] Notice/takedown contact is monitored and tested
- [ ] Contributor consent and privacy/retention wording reviewed by counsel
- [ ] Photo uploads, if enabled, are MIME-sniffed, private, EXIF-stripped, redacted, and retained/deleted by policy
- [ ] Arbitrary URL fetch/SSRF path is impossible
- [ ] Rate limiting and anti-spam operate on anonymous writes
- [ ] CSP, origin checks, secure cookies, security headers, and secret scanning pass
- [ ] Service/database/storage keys do not enter the client bundle

## SEO/accessibility/performance

- [ ] Demo, preview, and staging block crawlers
- [ ] Search, forms, admin, candidate, disputed, empty, and thin pages are `noindex`
- [ ] Every sitemap URL returns 200, is indexable, and self-canonicalizes
- [ ] Structured data includes only visible facts and validates syntactically
- [ ] No manufactured ratings, FAQs, prices, or availability
- [ ] Keyboard-only critical journeys work
- [ ] Forms have labels, errors, focus behavior, and accessible status messages
- [ ] Automated critical accessibility violations: zero
- [ ] Core public pages meet agreed performance budget on mobile

## Launch dataset gate

- [ ] Five brands selected from Phase 0 evidence
- [ ] 25–30 exact model families plus relevant variants
- [ ] 100–200 live original-source designs
- [ ] At least 30 independently verified exact-model fitments
- [ ] 100% public records complete for provenance, rights state, evidence, safety, and dates
- [ ] ≥98% source-link health
- [ ] Zero caution/blocked parts public
- [ ] Zero known wrong-model incidents unresolved

## Final release record

```text
Release commit:
Migration version:
Fitment ruleset:
Safety ruleset:
Source-policy review date:
Dataset audit report:
Search corpus report:
Sitemap audit report:
Backup/restore evidence:
Legal review date/scope:
Safety/rights inbox owner:
Go/no-go approver:
```
