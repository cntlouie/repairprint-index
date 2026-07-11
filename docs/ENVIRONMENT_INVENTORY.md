# WP-00 environment inventory

Recorded on 2026-07-11. This records observed state; it does not substitute
placeholder values for infrastructure that has not been provisioned.

## Application environments

| Environment | Status | Runtime and data | `DEMO_MODE` | Public origin | Crawler policy |
| --- | --- | --- | --- | --- | --- |
| Local | Ready | Node.js 22.22.0 observed; npm 10.9.4; optional Docker PostgreSQL fixture | `true` by template and fail-closed when absent | `http://localhost:3000` | Disallow all, empty sitemap, page-level `noindex` |
| CI | Ready; initial remote run passed | GitHub Actions, Node.js 24, `npm ci`, full `npm run check`; no database required for WP-00 | `true` set by workflow | None | Build is non-public and demo-locked |
| Pull-request preview | Provisioned through Vercel Git integration; first branch deployment pending this evidence push | Vercel Hobby, Next.js preset, root `./`; demo repository only | `true` for Preview | Assigned per branch deployment | Must disallow all, emit an empty sitemap, and render page-level `noindex` |
| Staging/demo | Ready | Vercel Hobby project `repairprint-index`; managed PostgreSQL belongs to WP-01 | `true` | `https://repairprint-index.vercel.app` | Verified 200 responses, disallow-all robots, empty sitemap, and page-level `noindex` on 2026-07-11 |
| Launch production | Not enabled; launch is outside WP-00 | Vercel project exists, but launch database and release controls are deferred | Must remain `true` until every release gate approves exactly `false` | No launch origin assigned | Block all while demo; production indexing requires the release record |

## Repository and release controls

| Control | Required state | Observed state |
| --- | --- | --- |
| Project Git boundary | This folder is its own repository | Initialized locally on `main`; no parent-repository traversal |
| Remote production repository | Private remote with an accountable owner | Private repository created at `https://github.com/cntlouie/repairprint-index`; local `main` tracks `origin/main` |
| Default branch | `main` | Configured locally |
| Branch protection | Pull request required; `verify` CI required; no force push or deletion; administrators included | Classic `main` rule recorded with pull request, approval, conversation-resolution, status-check, and no-bypass settings; GitHub marks it **Not enforced** for this private personal-account repository — blocks WP-00 acceptance |
| CI | Pull requests and pushes to `main` run `npm ci` then `npm run check` | Workflow committed in `.github/workflows/ci.yml`; initial `main` run passed at `https://github.com/cntlouie/repairprint-index/actions/runs/29165624562` |
| Dependency source | Locked npm dependencies | `package-lock.json` present; clean install command is `npm ci` |
| Secret handling | Provider secrets stored only in encrypted environment settings; local files ignored | `.env*` ignored except `.env.example`; source scan is part of `npm run check`; no provider secrets supplied |
| Deployment approval | Named owner verifies preview crawler lock before accepting WP-00 | Repository owner `cntlouie`; staging/demo crawler probe passed on 2026-07-11; branch preview URL still pending |

## Environment variables

| Variable | Local | CI | Preview | Staging | Production | Exposure rule |
| --- | --- | --- | --- | --- | --- | --- |
| `DEMO_MODE` | `true` | `true` | Required `true` | Required `true` | Required `true` until launch approval | Server-only |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Not required | Set to assigned preview origin | Set to assigned staging origin | Set to assigned production origin | Public by design; never include credentials |
| `DATABASE_URL` | Local Docker credential from `.env.example` | Not required for WP-00 | Not required for WP-00 | Deferred to WP-01 encrypted configuration | Deferred; do not provision in WP-00 | Server-only secret outside local fixture |
| `ADMIN_EMAILS` | Example value only; admin is not implemented | Not required | Not configured | Deferred to WP-03 | Deferred to WP-03 | Server-only |
| Object-storage variables | Empty and unused | Not required | Not configured | Deferred to optional WP-09 | Deferred to optional WP-09 | Server-only secrets |

## External actions required before WP-00 acceptance

1. Move the private repository to an organization/account tier that enforces the
   recorded `main` protection rule, or select another private Git host with
   equivalent enforced controls. Do not make the repository public merely to
   bypass this requirement.
2. Once enforcement is available, attach the successful `verify` job as the
   named required status check and confirm direct pushes are rejected.
3. Record and probe the first pull-request preview URL after this branch push.
4. Record immutable evidence for enforced protection settings and the branch
   preview in the WP-00 handoff.
