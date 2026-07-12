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
2. resolves a deployment-owned Vercel client address and never trusts generic
   forwarding headers;
3. consumes atomic 5-per-10-minute and 20-per-day PostgreSQL buckets;
4. accepts only identity-encoded JSON or URL-encoded bodies up to 16 KiB;
5. gives a populated honeypot the same opaque receipt as a queued request;
6. strictly validates fields, explicit private-queue/contribution consent, and
   separate email consent when contact is supplied;
7. verifies the single-use challenge at Cloudflare's fixed Siteverify endpoint,
   including the route action and configured hostname; and
8. transactionally inserts only into the private queue.

Turnstile server validation is mandatory outside explicit demo mode. Tokens
expire after five minutes and are single use; RepairPrint never stores or logs
the token or raw validation response. The official provider references are
[server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
and [client rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/).
Vercel documents the deployment-owned forwarded address in its
[request-header reference](https://vercel.com/docs/headers/request-headers).

Submitted source/evidence URLs allow HTTP(S) only, reject embedded credentials,
and are stored for private moderation. This handler performs no DNS lookup,
redirect resolution, HEAD request, metadata request, or source fetch. WP-10
allowlisted adapters remain separate.

## Deduplication and privacy

The browser supplies a per-render UUID. Only its HMAC digest is stored. Reuse
with different complete request/contact semantics returns a stable conflict.
An independent semantic HMAC collapses active duplicates only for the same
pseudonymous contributor. Missing-part free-form notes are excluded from that
semantic key, while fit outcome is included. Brand, exact model, OEM identifier,
design revision, and canonical part punctuation remain strict: `DV-100` and
`DV/100` never collapse. Different contributors remain independent evidence.

`SUBMISSION_HMAC_SECRET` rotation changes pseudonymous and semantic digests. It
therefore requires a reviewed dual-read/rekey plan; replacing it without that
plan temporarily weakens active deduplication and demand grouping. It must
never be reused as a Turnstile, database, or provider credential.

The display payload is retained privately and excludes email, honeypot,
challenge, consent controls, idempotency token, and client identity. Contact is
kept in one private column. Public roles have no base-table grants and public
views select none of these fields.

Potentially identifying evidence URLs are also redacted from the general AAL1
editor queue. A dedicated no-store staff detail endpoint returns one stored URL
only after `evidence:review` authorization, which requires reviewer/admin AAL2.
It returns text data only and never fetches or embeds the target.

## Consent and follow-up

The server records the operating-draft consent versions and timestamp; clients
cannot choose them. The current wording is an engineering operating draft and
does **not** close the launch checklist item requiring counsel review of consent
and privacy/retention wording.

Optional contact consent creates one private follow-up row in
`awaiting_event`, with no delivery time. It is not an email job. Only an
explicit future match or moderator-question event can call the server-side
trigger that moves it to `pending`; provider delivery is not implemented in
WP-08. Legacy version-zero emails never receive inferred consent or hooks.

Rate buckets expire after 48 hours and are removed opportunistically. A final
submission/contact retention period still requires the counsel-reviewed policy;
until then production intake must not be enabled as if that legal gate passed.
