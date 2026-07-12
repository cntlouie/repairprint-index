# Anonymous contribution operations

WP-08 implements three private intake paths: missing-part demand, design links,
and exact-model/design-revision fit outcomes. Every accepted request is
`pending`; none writes a model, design, fitment, evidence, safety, search, or
other public record. `print_failed` remains a separate observation from
`does_not_fit` in schema, fingerprints, storage, and tests.

## Request boundary

The canonical routes are under `/api/v1/submissions/*`; the earlier
undocumented aliases are removed. The shared handler:

1. requires the exact configured `Origin`;
2. parses the deployment-owned Vercel client address with a standards-aware IP
   library and never trusts generic forwarding headers;
3. consumes atomic PostgreSQL buckets for a global network emergency budget
   (15 per 10 minutes and 60 per day), then an independent endpoint/contributor
   budget (5 per 10 minutes and 20 per day);
4. accepts only identity-encoded JSON or URL-encoded bodies up to 16 KiB;
5. gives a populated honeypot an indistinguishable opaque receipt without
   persisting anything;
6. structurally validates fields and records the normalized contact/consent
   decision used by the idempotency fingerprint;
7. verifies the single-use challenge at Cloudflare's fixed Siteverify endpoint,
   including the route action and configured hostname;
8. compares any same-kind/network-actor/client-UUID row and returns either its
   stable receipt or a safe conflict; and
9. for a new row, validates explicit private-queue/contribution consent plus
   separate email consent before transactionally inserting into the private
   queue.

Turnstile server validation is mandatory outside explicit demo mode. Tokens
expire after five minutes and are single use; RepairPrint never stores or logs
the token or raw validation response. The official provider references are
[server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
and [client rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/).
Vercel documents the deployment-owned forwarded address in its
[request-header reference](https://vercel.com/docs/headers/request-headers).

IPv6 compression/case variants are canonicalized, and IPv4-mapped IPv6 is
folded to the equivalent IPv4 identity. Lists, zones, ports, brackets, malformed
addresses, and generic forwarding headers fail closed. Network identity remains
an abuse-control input. When no email is supplied, contributors behind one NAT
may be conservatively collapsed for semantic deduplication and private demand
metrics. WP-08 deliberately does not add a persistent browser identifier to
improve that estimate; rate limiting remains network based and this is a known
v0 measurement limitation.

Submitted source/evidence URLs are validated before URL parsing. Literal and
encoded controls, malformed percent encoding, backslashes, credentials, and
non-HTTP(S) schemes are rejected. The stored value is the parser's canonical
HTTP(S) URL. This handler performs no DNS lookup, redirect resolution, HEAD
request, metadata request, or source fetch. WP-10 allowlisted adapters remain
separate.

## Deduplication and privacy

The browser supplies a per-render UUID. Only its HMAC digest is stored. The
database scopes it by submission kind and a separate, contact-independent HMAC
of the canonical deployment-owned network actor. Changing, adding, or removing
an email therefore cannot escape an existing UUID namespace. Reuse in that
scope with the same normalized payload, contact decision, consent decision, and
server-selected consent/retention versions returns the original private row's
database-generated opaque receipt; the receipt is distinct from the private row
ID. Any changed fingerprint dimension returns a deterministic conflict, even
when the changed request's email consent would be invalid for a brand-new row.
Every retry and conflict attempt still passes the global/endpoint rate gates and
single-use Turnstile verification before private lookup.

The same UUID used for another endpoint kind or canonical network actor enters
an independent idempotency namespace. A different network-only contributor can
therefore create an independent row and receipt; the same normalized email still
represents one semantic contributor across networks and remains subject to the
separate active-content dedupe rule. A composite unique index plus transactional
retry lookup gives concurrent identical retries one row and one stable receipt
without revealing another actor's record. When a new UUID is semantically
deduplicated to an existing active row, `submission_idempotency_bindings`
durably maps that actor/kind/UUID to the existing receipt together with the new
request's own fingerprint. An exact replay remains stable; changing contact,
consent, policy versions, or payload then conflicts instead of escaping through
the semantic-dedupe path. That independent semantic HMAC uses the normalized
email when supplied, otherwise the network identity, and collapses active
duplicates only for that pseudonymous contributor. Missing-part
free-form notes are excluded from that semantic key, while fit outcome is
included. Brand, exact model, OEM identifier, design revision, and canonical
part punctuation remain strict: `DV-100` and `DV/100` never collapse. Different
contributors remain independent evidence.

`SUBMISSION_HMAC_SECRET` rotation changes pseudonymous and semantic digests. It
therefore requires a reviewed dual-read/rekey plan; replacing it without that
plan temporarily weakens active deduplication and demand grouping. It must
never be reused as a Turnstile, database, or provider credential.

The display payload is retained privately and excludes email, honeypot,
challenge, consent controls, idempotency token, and client identity. Contact and
the idempotency binding actor/key/fingerprint remain private columns. Public
roles have no base-table grants and public views select none of these fields.

Potentially identifying evidence URLs are also redacted from the general AAL1
editor queue. A dedicated no-store staff detail endpoint returns one stored URL
only after `evidence:review` authorization, which requires reviewer/admin AAL2.
It returns text data only and never fetches or embeds the target.

The evidence endpoint is intentionally backend-only in WP-08; no dashboard
exposure is required. Persistent intake, cleanup, typed follow-up events, and
this evidence lookup use `SUBMISSION_DATABASE_URL`. When the private connection
is opened, the server verifies that its actual PostgreSQL identity is
`repairprint_submission_service`; migration 0006 grants that role only the
private-table operations required by these paths. `anon` and ordinary
`authenticated` retain no submission-base-table access, and the safe public
catalogue/search grants are unchanged.

## Consent and follow-up

The server records the operating-draft consent versions and timestamp; clients
cannot choose them. The current wording is an engineering operating draft and
does **not** close the launch checklist item requiring counsel review of consent
and privacy/retention wording.

Optional contact consent stores only the current consent version, timestamp,
private contact, and configured deadline. Consent alone creates **zero** rows in
`submission_email_follow_ups`. A later typed `matching_publication` or
`moderator_question` server event may create one idempotent pending row only
after rechecking the current consent version, active submission, existing
contact, and both unexpired retention deadlines. Its `eventId` must be the
server-owned UUID of the reviewed publication/moderator event; arbitrary labels
and client values are rejected, and the event kind must match the submission
kind and constrained template. No provider, worker, send operation, or
mail-configuration fallback exists in WP-08. Legacy version-zero emails never
receive inferred consent or hooks.

## Retention and cleanup operations

Every version-one row stores the server-selected
`retention_policy_version`, `retention_expires_at`, and, when contact exists,
`contact_retention_expires_at`. Production intake fails closed until
`SUBMISSION_RETENTION_POLICY_VERSION`, `SUBMISSION_RETENTION_DAYS`, and
`SUBMISSION_CONTACT_RETENTION_DAYS` are present and valid. The contact duration
cannot exceed the submission duration. Repository defaults are demo-only test
fixtures and do not express a legal policy.

Run one bounded cleanup batch with:

```bash
npm run submissions:cleanup
```

`SUBMISSION_CLEANUP_BATCH_SIZE` is optional (default 100, maximum 1000). The
operation locks a bounded ordered batch, deletes fully expired private
submissions and all related private bindings/follow-up rows, and redacts expired
contact, consent, contact-derived contributor identity, and every associated
binding fingerprint while a non-contact submission remains within policy.
Repeated and concurrent runs are safe. It never writes public catalogue data
and cannot schedule mail.

Before enabling persistent production intake, the deployment owner must obtain
the reviewed policy values, provision the named-role credential, schedule this
command at an approved cadence, and assign an operator to alert on a missing or
non-zero run and monitor the structured deletion/redaction counts. WP-08 does
not silently create that external scheduler. Rate buckets expire after 48 hours
and are removed opportunistically by intake.
