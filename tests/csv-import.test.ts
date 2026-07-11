import { describe, expect, it } from "vitest";

import { emptyImportResolutionIndex } from "@/domain/import-resolution";
import {
  assertImportChecksum,
  dryRunCsvImport,
  exportCandidateRows,
  type ImportFiles,
} from "@/lib/csv-import";
import { loadImportPack } from "../scripts/load-import-pack";

const fixtureDirectory = "data/fixtures/phase0-demo";

function fixture(): ImportFiles {
  return loadImportPack(fixtureDirectory);
}

describe("CSV candidate imports", () => {
  it("round-trips all 20 fictional Phase 0 rows", () => {
    const first = dryRunCsvImport(fixture());
    expect(first.canCommit).toBe(true);
    expect(first.counts).toEqual({ insert: 20, update: 0, unchanged: 0, reject: 0 });
    expect(first.errors).toEqual([]);
    expect(first.collisions).toEqual([]);

    const roundTrip = dryRunCsvImport(exportCandidateRows(first.rows));
    expect(roundTrip.canCommit).toBe(true);
    expect(roundTrip.rows.map((row) => row.payload)).toEqual(first.rows.map((row) => row.payload));
  });

  it("treats a repeated import as unchanged rather than duplicating rows", () => {
    const first = dryRunCsvImport(fixture());
    const existing = { ...emptyImportResolutionIndex(), idempotencyKeys: new Set(first.rows.map((row) => row.idempotencyKey)) };
    const second = dryRunCsvImport(fixture(), existing);
    expect(second.counts).toEqual({ insert: 0, update: 0, unchanged: 20, reject: 0 });
    expect(second.canCommit).toBe(true);
  });

  it.each([
    {
      name: "missing provenance",
      mutate(files: ImportFiles) {
        files["product_models.csv"] = files["product_models.csv"].replace(",source-demo-manual-201\n", ",\n");
      },
      code: "MISSING_PROVENANCE",
    },
    {
      name: "model collision",
      mutate(files: ImportFiles) {
        files["product_identifiers.csv"] = files["product_identifiers.csv"].replace("DV-201-B,DV-201-B,DV201B", "DV201A,DV201A,DV201A");
      },
      code: "MODEL_AMBIGUOUS",
    },
    {
      name: "OEM collision",
      mutate(files: ImportFiles) {
        files["oem_parts.csv"] = files["oem_parts.csv"].replace("DM-0004218,DM-0004218,DM0004218", "DM0004217,DM0004217,DM0004217");
      },
      code: "PART_NUMBER_AMBIGUOUS",
    },
    {
      name: "duplicate design landing page and revision",
      mutate(files: ImportFiles) {
        files["designs.csv"] = files["designs.csv"].replace("https://example.invalid/designs/demo-dv202-foot,r1", "https://example.invalid/designs/demo-dv201-latch,r1");
      },
      code: "DUPLICATE_EXTERNAL_ITEM",
    },
    {
      name: "verification authority in imported data",
      mutate(files: ImportFiles) {
        files["fitments.csv"] = files["fitments.csv"].replace("candidate_match,0", "verified_fit,100");
      },
      code: "IMPORT_AUTHORITY_EXCEEDED",
    },
    {
      name: "unknown design revision",
      mutate(files: ImportFiles) {
        files["fitments.csv"] = files["fitments.csv"].replace("design-demo-dv201-latch,r1", "design-demo-dv201-latch,r9");
      },
      code: "REVISION_UNKNOWN",
    },
    {
      name: "supersession cycle",
      mutate(files: ImportFiles) {
        files["oem_parts.csv"] = files["oem_parts.csv"]
          .replace("Demo bin latch,,draft", "Demo bin latch,superseded_by:oem-demo-0004218,draft")
          .replace("Demo revised bin latch,,draft", "Demo revised bin latch,superseded_by:oem-demo-0004217,draft");
      },
      code: "SUPERSESSION_CYCLE",
    },
  ])("rejects $name with an actionable code", ({ mutate, code }) => {
    const files = fixture();
    mutate(files);
    const report = dryRunCsvImport(files);
    expect(report.canCommit).toBe(false);
    expect(report.errors.map((entry) => entry.code)).toContain(code);
    expect(report.counts.reject).toBeGreaterThan(0);
  });

  it("requires the exact unchanged dry-run checksum before commit", () => {
    const files = fixture();
    const report = dryRunCsvImport(files);
    const changed = fixture();
    changed["components.csv"] = changed["components.csv"].replace("Demo base foot", "Changed demo base foot");
    expect(() => assertImportChecksum(report, changed, report.inputChecksum)).toThrow("IMPORT_INPUT_CHANGED");
  });

  it("blocks commit when the unchanged dry run contains ambiguity", () => {
    const files = fixture();
    files["product_identifiers.csv"] = files["product_identifiers.csv"].replace(
      "DV-201-B,DV-201-B,DV201B",
      "DV201A,DV201A,DV201A",
    );
    const report = dryRunCsvImport(files);
    expect(() => assertImportChecksum(report, files, report.inputChecksum)).toThrow("IMPORT_COMMIT_BLOCKED");
  });

  it("rejects a changed CSV contract header", () => {
    const files = fixture();
    files["components.csv"] = files["components.csv"].replace("safety_profile", "unreviewed_field");
    const report = dryRunCsvImport(files);
    expect(report.errors.map((entry) => entry.code)).toContain("IMPORT_HEADER_MISMATCH");
  });

  it("reports malformed CSV quoting without crashing the dry run", () => {
    const files = fixture();
    files["components.csv"] += '"unterminated';
    const report = dryRunCsvImport(files);
    expect(report.canCommit).toBe(false);
    expect(report.errors).toContainEqual(
      expect.objectContaining({ file: "components.csv", code: "IMPORT_ROW_MALFORMED" }),
    );
  });
});
