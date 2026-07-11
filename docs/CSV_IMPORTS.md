# CSV candidate import operations

WP-04 imports reviewed CSV packs into a private candidate queue. Importing is
not publication, moderation acceptance, fit verification, a safety decision,
or an entity merge.

## Contract

An import directory contains all eight versioned files in dependency order:

1. `product_models.csv`
2. `product_identifiers.csv`
3. `components.csv`
4. `oem_parts.csv`
5. `product_components.csv`
6. `designs.csv`
7. `fitments.csv`
8. `fitment_evidence.csv`

Headers are exact. Display values are retained while identifier strict/loose
keys are independently recomputed. Imported canonical records must remain
`draft`; fitments must remain `candidate_match`; evidence must remain
`pending`. Design rows require an original landing-page URL, creator, licence
state (including `NOT-STATED`), retrieval/check dates, rights check, and
attribution. The importer never fetches a URL.

## Dry run and commit

Run a dry run against the current database:

```bash
npm run import:csv -- --dir data/fixtures/phase0-demo
```

The JSON report includes the input SHA-256 checksum, insert/unchanged/reject
counts, row-level errors, and the unresolved collision queue. A commit is
allowed only when the report has no errors. Supply the exact checksum printed
by that dry run plus the authorized staff actor and audit context:

```bash
npm run import:csv -- --dir data/fixtures/phase0-demo --commit \
  --expected-checksum sha256:... --actor-id 00000000-0000-0000-0000-000000000000 \
  --reason "Reviewed candidate pack" --request-id req_...
```

The commit re-runs validation against the database, recomputes the file
checksum, and writes the run, candidate rows, and audit event in one
transaction. The same input checksum returns the existing run. Per-row
idempotency keys prevent a row from being inserted by a later repackaged run.

The CLI is a server-side operator tool. Authorization must occur before it is
invoked; secrets and service credentials never enter a CSV or report.

When a reviewed dry run contains ambiguity, persist only its rejected rows and
collision records for later human resolution by replacing `--commit` with
`--queue-review`. This is an explicit audited write; an ordinary dry run is
read-only.

## Resolution rules

- Duplicate external key in one file: reject with `IMPORT_DUPLICATE_KEY`.
- Duplicate design landing URL plus revision: reject with `DUPLICATE_EXTERNAL_ITEM`.
- Strict or loose model collision within a brand: queue and reject with `MODEL_AMBIGUOUS`; never merge suffixes or regions.
- Strict or loose OEM collision within a brand: queue and reject with `PART_NUMBER_AMBIGUOUS`; a shared number is never fit authority.
- Unknown design revision: reject with `REVISION_UNKNOWN`.
- Missing cross-file dependency: reject with `REFERENCE_NOT_FOUND`.
- Supersession graph cycle: queue and reject with `SUPERSESSION_CYCLE`.
- Missing source/rights fields: reject with `MISSING_PROVENANCE` or `LICENSE_NOT_RECORDED`.
- Any imported review/publication authority: reject with `IMPORT_AUTHORITY_EXCEEDED`.
- File changed after dry run: reject with `IMPORT_INPUT_CHANGED`.

## Recovery

Migration `0002_dizzy_magik.sql` is additive. It creates four import enums and
the `import_runs`, `import_rows`, and `import_collisions` tables. Existing
catalog and audit records are not rewritten.

If migration or import commit fails, stop the writer and correct forward. A
transaction failure leaves no partial import. Do not delete a committed run or
candidate row to retry: correct the CSV and create a new checksummed run.
Because the audit log and candidate history are retained, rollback after use is
forward-only. On an unused empty environment, remove the three tables in
collision/row/run order and then remove the four enums.
