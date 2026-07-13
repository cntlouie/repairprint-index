import { describe, expect, it } from "vitest";

import {
  assessMigrationLedger,
  type ExpectedMigrationLedgerEntry,
} from "../src/domain/migration-ledger";

const expected: readonly ExpectedMigrationLedgerEntry[] = [
  { tag: "0000_first", hash: "hash-0", createdAt: "1000" },
  { tag: "0001_second", hash: "hash-1", createdAt: "2000" },
];

describe("migration ledger verification", () => {
  it("accepts an exact ordered timestamp and hash match", () => {
    expect(
      assessMigrationLedger(expected, [
        { hash: "hash-0", createdAt: "1000" },
        { hash: "hash-1", createdAt: "2000" },
      ]),
    ).toEqual({ valid: true, violations: [] });
  });

  it.each([
    ["missing row", [{ hash: "hash-0", createdAt: "1000" }]],
    [
      "extra row",
      [
        { hash: "hash-0", createdAt: "1000" },
        { hash: "hash-1", createdAt: "2000" },
        { hash: "hash-2", createdAt: "3000" },
      ],
    ],
    [
      "changed SQL hash",
      [
        { hash: "hash-0", createdAt: "1000" },
        { hash: "different", createdAt: "2000" },
      ],
    ],
    [
      "changed journal timestamp",
      [
        { hash: "hash-0", createdAt: "1000" },
        { hash: "hash-1", createdAt: "2001" },
      ],
    ],
    [
      "reordered rows",
      [
        { hash: "hash-1", createdAt: "2000" },
        { hash: "hash-0", createdAt: "1000" },
      ],
    ],
  ])("rejects a %s", (_label, recorded) => {
    expect(assessMigrationLedger(expected, recorded).valid).toBe(false);
  });
});
