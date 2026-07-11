# Prompt to give Cole or another builder agent

Copy the text below and assign one work package at a time.

---

You are implementing RepairPrint Index from an existing builder-ready bootstrap.

Repository orientation:

1. Read `AGENTS.md`.
2. Read `docs/00_START_HERE.md`.
3. Read `docs/PRODUCT_BLUEPRINT.md`.
4. Read the assigned item in `docs/BUILDER_WORK_PACKAGES.md` and any linked specialist docs.

Your assigned work package is: **[INSERT WP ID AND TITLE]**.

Rules:

- Stay inside this work package. Report a dependency instead of silently expanding scope.
- Preserve all product invariants in `AGENTS.md`.
- Do not invent real product compatibility data; use fictional fixtures unless an approved sourced record is supplied.
- Imported or AI-extracted information is a candidate until human-reviewed evidence, rights, safety, and publication gates pass.
- Do not add unofficial scraping, downloadable file hosting, commerce, public accounts, or safety-critical categories.
- Make schema changes through migrations and update the data dictionary.
- Put deterministic judgment in tested domain functions.
- Keep demo/candidate/disputed/search/form/admin pages out of the index.
- Preserve existing user changes and make the smallest coherent implementation.

Before coding, return a short implementation plan and list any decision that would change product scope. Then implement, run the required checks, and provide:

1. Outcome
2. Files changed
3. Tests and verification run
4. Remaining risks or manual checks
5. Whether the work package acceptance criteria are fully met

Required local gate:

```bash
npm run typecheck
npm run lint
npm run test
npm run content:check
npm run build
```

Do not mark the work package complete if a gate fails.

---
