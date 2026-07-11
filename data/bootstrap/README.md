# Launch data workspace

Keep reviewed launch import packs here. Do not commit private user submissions, raw model-label photos, API keys, or source snapshots.

Suggested sequence:

1. Copy the files from `../templates/` into a dated batch directory.
2. Replace fictional examples with sourced records.
3. Include an `import-manifest.json` with batch owner, source-policy review, checksums, and reviewer.
4. Run the future importer in dry-run mode.
5. Resolve every ambiguous/rejected row.
6. Commit only the exact checksum that passed dry run.

Real compatibility data must carry source citations in the database; a CSV row by itself is not evidence.
