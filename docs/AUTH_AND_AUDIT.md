# Staff authentication and audit controls

## Provider and account lifecycle

RepairPrint uses Supabase Auth for staff identity. Staging is configured for
invite-only email authentication:

- public user signup is disabled;
- anonymous sign-in is disabled;
- email confirmation remains enabled;
- TOTP MFA is enabled on the Free plan;
- AAL1 sessions are limited to 15 minutes while a factor is awaiting
  verification.

There is no public staff-signup route. Server invitation code calls only the
Supabase admin invite endpoint with `SUPABASE_SERVICE_ROLE_KEY`, which must
never be exposed to browser code. An invited Auth user has no RepairPrint
authority until a matching active `staff_profiles` row exists.

## Roles and MFA

- `editor`: prepare and normalize drafts; cannot review or publish.
- `reviewer`: review fitment/evidence/rights/safety and publish or unpublish;
  every request requires an AAL2 token.
- `admin`: reviewer abilities plus staff, policy, archive, and operational
  controls; every request requires an AAL2 token.

Server helpers verify the JWT issuer, audience, signature, subject, email, and
assurance level, then load the database profile and authorize the exact action.
Client claims never define a RepairPrint role.

## Audit contract

Every privileged change records:

- staff actor ID;
- action and entity identity;
- before and after values;
- non-empty reason;
- non-empty request ID;
- database timestamp.

`audit_log` is append-only. PostgreSQL rejects `UPDATE`, `DELETE`, and
`TRUNCATE` through immutable triggers, including accidental application-owner mutations. Disabled
staff profiles are retained so historical attribution remains resolvable.

## Migration and recovery

Migration `0001_fixed_jack_murdock.sql` is additive. It creates the staff enums
and table, tightens empty audit columns, adds attribution foreign keys, creates
the immutability trigger, and creates four published-only security-barrier
views.

Before applying to a database that could contain audit rows, verify every row
already has actor, reason, and request ID; otherwise stop and review rather than
inventing attribution. The current staging restore audit contained zero audit
rows, so the constraints are safe to apply.

Rollback is forward-only after staff or audit data exists: disable staff access,
deploy a reviewed corrective migration, and preserve the audit rows. On an
unused empty environment only, the views/trigger/function, audit foreign key,
staff table, and staff enums can be removed in reverse dependency order.
