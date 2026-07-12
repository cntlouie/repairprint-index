# Environment inventory

Recorded on 2026-07-11. This records observed state; it does not substitute
placeholder values for infrastructure that has not been provisioned.

## Application environments

| Environment | Status | Runtime and data | `DEMO_MODE` | Public origin | Crawler policy |
| --- | --- | --- | --- | --- | --- |
| Local | Application ready; database runtime unavailable on current workstation | Node.js 22.22.0 observed; npm 10.9.4; Docker fixture defines separate `repairprint` and guarded `repairprint_test` databases with the 26-table import candidate migration | `true` by template and fail-closed when absent | `http://localhost:3000` | Disallow all, empty sitemap, page-level `noindex` |
| CI | Ready; database gate added in WP-01 | GitHub Actions, Node.js 24, `npm ci`, PostgreSQL 17 service, full `npm run check`; zero-state migration and double-seed check use isolated `repairprint_test` | `true` set by workflow | None | Build is non-public and demo-locked |
| Pull-request preview | Ready | Vercel Hobby, Next.js preset, root `./`; demo repository only | `true` for Preview | `https://repairprint-index-git-codex-wp-4c0099-siggis-projects-57bb4b3c.vercel.app` | Vercel Authentication blocks unauthenticated crawlers; authenticated app probe renders `noindex, nofollow, nocache` |
| Staging/demo | Web and managed database ready; WP-04 migration applied after protected-main verification | Vercel Hobby project `repairprint-index`; Supabase Free project `repairprint-index-staging` (`inscdebgwdzubyzfifkd`) in West EU (Ireland); public Data API disabled | `true` | `https://repairprint-index.vercel.app` | Verified 200 responses, disallow-all robots, empty sitemap, page-level `noindex`, 26-table migration, idempotent fictional seed, encrypted artifact, and zero-published-fitment restore audit on 2026-07-11; migration and anonymous-access audit passed in CI run `29170633977` |
| Launch production | Not enabled; launch is outside WP-00 | Vercel project exists, but launch database and release controls are deferred | Must remain `true` until every release gate approves exactly `false` | No launch origin assigned | Block all while demo; production indexing requires the release record |

## Repository and release controls

| Control | Required state | Observed state |
| --- | --- | --- |
| Project Git boundary | This folder is its own repository | Initialized locally on `main`; no parent-repository traversal |
| Remote production repository | Remote with an accountable owner and an enforceable protected default branch | Public repository at `https://github.com/cntlouie/repairprint-index`; local `main` tracks `origin/main`; no license is granted by this repository |
| Default branch | `main` | Configured locally |
| Branch protection | Pull request required; `verify` CI required; no force push or deletion; administrators included | Enforced classic `main` rule currently applies to one branch and requires a pull request, the GitHub Actions `verify` check, conversation resolution, and no bypass; approval count is zero for the solo owner; force pushes and deletions are disabled |
| CI | Pull requests and pushes to `main` run `npm ci` then `npm run check`; only a verified push to protected `main` can apply and audit pending staging migrations | Workflow committed in `.github/workflows/ci.yml`; pull requests have no staging database credential or mutation path |
| Dependency source | Locked npm dependencies | `package-lock.json` present; clean install command is `npm ci` |
| Secret handling | Provider secrets stored only in encrypted environment settings; local files ignored | `.env*` ignored except `.env.example`; source scan is part of `npm run check`; backup passphrase is a GitHub Actions secret with a separate DPAPI-protected owner recovery copy outside the repository |
| Deployment approval | Named owner verifies preview crawler lock before accepting WP-00 | Repository owner `cntlouie`; staging/demo and authenticated branch-preview probes passed on 2026-07-11 |

## Environment variables

| Variable | Local | CI | Preview | Staging | Production | Exposure rule |
| --- | --- | --- | --- | --- | --- | --- |
| `DEMO_MODE` | `true` | `true` | Required `true` | Required `true` | Required `true` until launch approval | Server-only |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Not required | Set to assigned preview origin | Set to assigned staging origin | Set to assigned production origin | Public by design; never include credentials |
| `DATABASE_URL` | Local Docker pooled/runtime credential from `.env.example` | Not used by the zero-state test | Vercel transaction-pooler credential configured 2026-07-12 | Vercel transaction-pooler credential configured 2026-07-12 | Configured only for the crawler-blocked demo deployment; launch approval is still required | Server-only secret outside local fixture |
| `DATABASE_DIRECT_URL` | Local Docker direct credential from `.env.example` | Not required | Not configured | GitHub secret `STAGING_DATABASE_DIRECT_URL` uses the provider's IPv4-compatible session pooler because the direct endpoint is IPv6-only; rotated with the provider password on 2026-07-12 | Deferred | Server-only; never expose to application clients |
| `BACKUP_ENCRYPTION_PASSPHRASE` | DPAPI-protected owner recovery copy outside repository | GitHub Actions secret for scheduled backup/restore workflow | Never configured | Required for client-side GPG encryption before artifact upload | Deferred | Never log, commit, or expose to application runtime |
| `RESTORE_DATABASE_URL` | Not configured | Temporary GitHub Actions secret removed after successful run `29167872754` | Never configured | Not configured; isolated restore project was deleted after evidence capture | Never configured | Must never target staging or production |
| `DATABASE_TEST_URL` | Guarded local `repairprint_test` credential | CI-only PostgreSQL 17 service credential | Never configured | Never point at staging | Never configured | Destructive test-only value; script rejects non-local hosts and other database names |
| `SUPABASE_URL` | Example project URL only | Not required | Provider URL only when staff routes land | Configured in Vercel Production and Preview on 2026-07-11 | Deferred | Server-only in the current implementation |
| `SUPABASE_SERVICE_ROLE_KEY` | Empty | Never configured | Never exposed | Required only for reviewed server-side staff invitations | Deferred | Secret; never browser-exposed, logged, or committed |
| `NEXT_PUBLIC_SUPABASE_URL` | Example project URL only | Not required | Provider URL for staff login | Configured in Vercel Production and Preview on 2026-07-11 | Deferred | Browser-safe provider identifier; no authority by itself |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Empty | Not required | Provider publishable or legacy anon key for staff login | Configured in Vercel Production and Preview on 2026-07-11 | Deferred | Browser-safe key only; never substitute a service-role key |
| Object-storage variables | Empty and unused | Not required | Not configured | Deferred to optional WP-09 | Deferred to optional WP-09 | Server-only secrets |

## WP-00 acceptance evidence

1. GitHub confirmed the repository is public and the classic `main` protection
   rule currently applies to one branch on 2026-07-11.
2. The rule requires a pull request, conversation resolution, and the GitHub
   Actions `verify` status check. The solo-owner approval count is zero. It applies to administrators without a
   bypass; force pushes and deletions remain disabled.
3. GitHub confirmed the protection settings were saved. The latest successful
   remote workflow and deployment evidence is linked from the WP-00 handoff.

## WP-03 authentication evidence

On 2026-07-11, Supabase staging showed public signup disabled, anonymous sign-in
disabled, email confirmation enabled, TOTP MFA enabled, and the recommended
15-minute AAL1 session limit enabled. Application authorization still requires
an active database staff profile; provider authentication alone grants no staff
role.
