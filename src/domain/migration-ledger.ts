export interface ExpectedMigrationLedgerEntry {
  readonly tag: string;
  readonly hash: string;
  readonly createdAt: string;
}

export interface RecordedMigrationLedgerEntry {
  readonly hash: string;
  readonly createdAt: string;
}

export interface MigrationLedgerAssessment {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export function assessMigrationLedger(
  expected: readonly ExpectedMigrationLedgerEntry[],
  recorded: readonly RecordedMigrationLedgerEntry[],
): MigrationLedgerAssessment {
  const violations: string[] = [];

  if (recorded.length !== expected.length) {
    violations.push(`Expected ${expected.length} migration ledger rows, found ${recorded.length}.`);
  }

  const maximumLength = Math.max(expected.length, recorded.length);
  for (let index = 0; index < maximumLength; index += 1) {
    const expectedEntry = expected[index];
    const recordedEntry = recorded[index];

    if (!expectedEntry) {
      violations.push(`Unexpected migration ledger row at position ${index}.`);
      continue;
    }
    if (!recordedEntry) {
      violations.push(`Missing migration ledger row for ${expectedEntry.tag}.`);
      continue;
    }
    if (recordedEntry.createdAt !== expectedEntry.createdAt) {
      violations.push(`Migration timestamp mismatch for ${expectedEntry.tag}.`);
    }
    if (recordedEntry.hash !== expectedEntry.hash) {
      violations.push(`Migration hash mismatch for ${expectedEntry.tag}.`);
    }
  }

  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze([...violations]),
  });
}
