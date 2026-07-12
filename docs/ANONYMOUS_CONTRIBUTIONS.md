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
3. verifies that the validated production HMAC key matches the private
   database singleton pin before deriving any rate or contribution identity;
4. consumes atomic PostgreSQL buckets for a global network emergency budget
   (15 per 10 minutes and 60 per day), then an independent endpoint/contributor
   budget (5 per 10 minutes and 20 per day);
5. accepts only identity-encoded JSON or URL-encoded bodies up to 16 KiB;
6. gives a populated honeypot an indistinguishable opaque receipt without
   persisting anything;
7. structurally validates fields and records the normalized contact/consent
   decision used by the idempotency fingerprint;
8. verifies the single-use challenge at Cloudflare's fixed Siteverify endpoint,
   including the route action and configured hostname;
9. compares any same-kind/network-actor/client-UUID row and returns either its
   stable receipt or a safe conflict; and
10. for a new row, validates explicit private-queue/contribution consent plus
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

The browser supplies a per-render UUID. A standards-aware parser serializes it
to the lowercase hyphenated canonical UUID before HMAC; merely changing letter
case cannot create another namespace. Only the HMAC digest is stored. The
database scopes it by submission kind and a separate, contact-independent HMAC
of the canonical deployment-owned network actor. Changing, adding, or removing
an email therefore cannot escape an existing UUID namespace. Reuse in that
scope with the same normalized payload, contact decision, consent decision, and
server-selected consent/retention versions returns the original semantic
parent's database-generated opaque receipt. Any changed fingerprint dimension
returns a deterministic conflict, even when the changed request's email consent
would be invalid for a brand-new row. Every retry and conflict attempt still
passes the global/endpoint rate gates and single-use Turnstile verification
before private lookup.

The same UUID used for another endpoint kind or canonical network actor enters
an independent idempotency namespace. A different network-only contributor can
therefore create an independent row and receipt; the same normalized email still
represents one semantic contributor across networks and remains subject to the
separate active-content dedupe rule. A composite unique index plus transactional
retry lookup gives concurrent identical retries one immutable intake and one
stable receipt without revealing another actor's record. `submissions` is the
semantic moderation parent S1: it stores only the canonical semantic payload
and contributor/content digests. Each accepted UUID is a separate immutable B
row in `submission_idempotency_bindings`, even when B1 and B2 point to S1 and
share its acknowledgment receipt R1. Every B row durably retains its own full
private payload, request fingerprint, all consent decisions and versions,
acceptance/challenge timestamps, contact-present/digest state, and independently
calculated deadlines. Its optional email lives in the separate
`submission_intake_contacts` child.

An exact replay returns R1; reusing that UUID with changed contact, consent,
policy versions, notes, or other request facts conflicts. A new UUID with the
same semantic contributor/content may also return R1, but its B2 snapshot must
commit before HTTP 202 and never overwrites or borrows B1's legal, contact,
wording, evidence, or retention state. Demand counts the semantic
contributor/content association once, not every binding. The semantic HMAC uses
the normalized email when supplied, otherwise the network identity, and
collapses active duplicates only for that pseudonymous contributor.
Missing-part free-form notes are excluded from that semantic key, while fit
outcome is included. Brand, exact model, OEM identifier, design revision, and
canonical part punctuation remain strict: `DV-100` and `DV/100` never collapse.
Different contributors remain independent evidence.

`SUBMISSION_HMAC_SECRET` is exactly 32 bytes supplied as 64 hexadecimal
characters. Generate it with a cryptographically secure generator:

```bash
openssl rand -hex 32
```

The runtime does not trim or repair the value and rejects malformed, repeated,
or recognizable placeholder material. The format is an enforceable transport
contract, not proof that an operator used a secure generator. CI and local
production-mode checks generate ephemeral keys at runtime; no reusable test key
belongs in the repository or logs. This key must never be reused as a
Turnstile, database, or provider credential.

WP-08 intentionally has no seamless live-key rotation. The private database
pin binds retained intake to one algorithm/framing version and one key
commitment. A missing or mismatched pin stops intake before identity hashes or
writes. Restore the original key to restore service. Live rotation requires a
future separately reviewed keyring/rekey package. Controlled pin replacement is
permitted only after no retained records depend on the prior key and an
owner/admin maintenance procedure explicitly performs the replacement.

Provision the initial pin with migration/admin credentials, never the
least-privilege submission credential:

```bash
DEMO_MODE=false DATABASE_URL="$DATABASE_DIRECT_URL" npm run submissions:key-pin
```

The command is idempotent only for the same version and commitment. An explicit
`npm run submissions:key-pin -- --replace` is accepted only when no semantic
parents, intakes, contacts, follow-ups, or rate buckets remain. The pin stores a
purpose-separated commitment, never the key itself, and the submission service
has SELECT-only access. Every HMAC-derived rate or intake write locks and
rechecks that pin inside its database transaction. Replacement locks the pin
and every dependent write table before evaluating the empty-state rule, so an
already-verified key-A request either commits before the decision (and makes
replacement refuse) or observes key B and fails closed.

Each intake's display payload is retained privately and excludes email,
honeypot, challenge, consent controls, idempotency token, and client identity.
The semantic parent contains only its canonical dedupe projection. Contact,
consent, receipt, private notes, and the intake actor/key/fingerprint remain
private relations or columns. Public roles have no base-table grants and public
views select none of these fields.

Potentially identifying evidence URLs are also redacted from the general AAL1
editor queue. A dedicated no-store staff detail endpoint returns one exact
intake's stored URL only after `evidence:review` authorization, which requires
reviewer/admin AAL2. It returns text data only and never fetches or embeds the
target.

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

Optional contact consent is intake-scoped. The immutable B row records the
decision, version, acceptance time, contact-present digest and configured
deadline; the normalized email is a separately expiring child. Consent alone
creates **zero** rows in `submission_email_follow_ups`. A later typed
`matching_publication` or `moderator_question` event may create one idempotent
pending row only after rechecking that exact intake's current consent, active
semantic parent, existing contact child, and both unexpired deadlines. One
intake can never borrow another intake's contact or approval. Its `eventId` must
be the server-owned UUID of the reviewed publication/moderator event; arbitrary
labels and client values are rejected, and the event kind must match the
submission kind and constrained template. No provider, worker, sender, send
operation, or mail-configuration fallback exists in WP-08. Legacy version-zero
emails never receive inferred consent or hooks.

Both the repository query and a database insert trigger evaluate eligibility
with the database clock; a caller cannot backdate an event or directly insert a
typed-looking row for an expired or unconsented intake. The database assigns
the pending row's availability timestamp.

## Retention and cleanup operations

Every immutable version-one intake stores its own server-selected
`retention_policy_version`, `retention_expires_at`, and, when contact exists,
`contact_retention_expires_at`, all calculated from that intake's acceptance
time. A later alias therefore never inherits an older intake's expiry.
Production intake fails closed until
`SUBMISSION_RETENTION_POLICY_VERSION`, `SUBMISSION_RETENTION_DAYS`, and
`SUBMISSION_CONTACT_RETENTION_DAYS` are present and valid. The contact duration
cannot exceed the submission duration. Repository defaults are demo-only test
fixtures and do not express a legal policy.

Run one bounded cleanup batch with:

```bash
npm run submissions:cleanup
```

`SUBMISSION_CLEANUP_BATCH_SIZE` is optional (default 100, maximum 1000). The
service has no direct intake/contact update or delete privilege. It may execute
only the fixed `SECURITY DEFINER` cleanup function owned by the separate
no-login `repairprint_submission_maintenance` role. The function accepts only
the bounded batch size, uses database time and a fixed safe search path, locks
an ordered batch with `SKIP LOCKED`, deletes qualifying follow-up/contact rows,
then deletes fully expired intakes. It deletes S1/R1 only after the final intake
has expired; E1 can remove B1 while preserving a later B2, S1 and R1. Accepted
snapshots and fingerprints are never rewritten. Database triggers reject live
deletion, direct mutation, truncation, orphan parents, and incomplete
contact-present intakes. Repeated and concurrent runs are safe. Cleanup reports
deleted contact, follow-up, intake, and semantic-parent counts, never writes
public catalogue data, and cannot schedule mail.

Before enabling persistent production intake, the deployment owner must obtain
the reviewed policy values, generate and securely store the HMAC key, provision
its database pin with owner/admin credentials, provision the named service-role
credential, schedule cleanup at an approved cadence, and assign an operator to
alert on a missing or non-zero run and monitor the structured deletion counts.
The maintenance function owner remains no-login. The separately credentialed
service role and maintenance role are non-superuser, non-bypass roles with no
privileged-role memberships. WP-08 does not silently create the external
scheduler. Rate buckets expire after 48 hours and are removed opportunistically
by intake.

Hosted Supabase PostgreSQL 17 may add one provider-administration membership for
each WP-08 role when the role is created: the WP-08 role is granted to `postgres`
by `supabase_admin` with `ADMIN` enabled and both `INHERIT` and `SET` disabled.
The migration and runtime audits allow either no provider rows (plain PostgreSQL)
or that complete two-row pair. They reject every other direction, member,
grantor, option set, partial pair, or additional membership. These rows do not
make either WP-08 role a member of a privileged role and do not let `postgres`
inherit or assume the WP-08 runtime identities.

When either role already exists, migration 0006 validates its complete
least-privilege attribute set and fails closed on any unsafe attribute. It does
not issue redundant attribute changes that hosted Supabase reserves for its
provider administrator.
