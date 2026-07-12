import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertSubmissionHmacKeyPin,
  deriveSubmissionHmacKeyCommitment,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
  type SubmissionHmacKeyPin,
} from "@/lib/submission-key-pin";
import { submissionHmac, type SubmissionIntakeError } from "@/lib/submission-security";

describe("anonymous-submission HMAC key pin", () => {
  it("purpose-separates the persisted commitment and version-separates rotations", () => {
    const secret = validRandomSecret();
    const current = deriveSubmissionHmacKeyCommitment(secret);
    const otherVersion = deriveSubmissionHmacKeyCommitment(secret, "hmac-sha256/v2");

    expect(current).toMatch(/^[0-9a-f]{64}$/u);
    expect(otherVersion).toMatch(/^[0-9a-f]{64}$/u);
    expect(otherVersion).not.toBe(current);
    expect(submissionHmac("submission-hmac-key-pin/v1", SUBMISSION_HMAC_ALGORITHM_VERSION, secret))
      .not.toBe(current);
  });

  it("accepts only a pin derived from the same valid runtime-generated key", () => {
    const secret = validRandomSecret();
    const pin = currentPin(secret);

    expect(() => assertSubmissionHmacKeyPin(pin, secret)).not.toThrow();
    expect(deriveSubmissionHmacKeyCommitment(secret)).toBe(pin.keyCommitment);
  });

  it.each([
    ["missing pin", undefined],
    ["null pin", null],
    ["short commitment", { hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION, keyCommitment: "00" }],
    ["non-hex commitment", {
      hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
      keyCommitment: "g".repeat(64),
    }],
  ] as const)("fails closed with a sanitized 503 for %s", (_label, pin) => {
    const secret = validRandomSecret();

    expectUnavailable(() => assertSubmissionHmacKeyPin(pin, secret), [secret, pin?.keyCommitment]);
  });

  it("fails closed when the configured key differs from the pinned key", () => {
    const pinnedSecret = validRandomSecret();
    const configuredSecret = distinctRandomSecret(pinnedSecret);
    const pin = currentPin(pinnedSecret);

    expectUnavailable(
      () => assertSubmissionHmacKeyPin(pin, configuredSecret),
      [pinnedSecret, configuredSecret, pin.keyCommitment],
    );
  });

  it("fails closed when the pin version differs even if its commitment matches that version", () => {
    const secret = validRandomSecret();
    const pin = {
      hmacVersion: "hmac-sha256/v2",
      keyCommitment: deriveSubmissionHmacKeyCommitment(secret, "hmac-sha256/v2"),
    } as const;

    expectUnavailable(
      () => assertSubmissionHmacKeyPin(pin, secret),
      [secret, pin.keyCommitment, pin.hmacVersion],
    );
  });

  it("gives valid-shaped mismatches at either end the same observable failure contract", () => {
    const secret = validRandomSecret();
    const commitment = deriveSubmissionHmacKeyCommitment(secret);
    const mismatches = [replaceHexDigit(commitment, 0), replaceHexDigit(commitment, commitment.length - 1)];

    const failures = mismatches.map((keyCommitment) => captureUnavailable(() => {
      assertSubmissionHmacKeyPin({ hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION, keyCommitment }, secret);
    }));

    expect(failures.map(safeErrorShape)).toEqual([
      { code: "SUBMISSION_UNAVAILABLE", message: "SUBMISSION_UNAVAILABLE", name: "SubmissionIntakeError", status: 503 },
      { code: "SUBMISSION_UNAVAILABLE", message: "SUBMISSION_UNAVAILABLE", name: "SubmissionIntakeError", status: 503 },
    ]);
    for (const [index, error] of failures.entries()) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(mismatches[index]!);
      expect(error).not.toHaveProperty("cause");
    }
  });
});

function currentPin(secret: string): SubmissionHmacKeyPin {
  return {
    hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
    keyCommitment: deriveSubmissionHmacKeyCommitment(secret),
  };
}

function validRandomSecret(): string {
  // Runtime CSPRNG material also exercises the production parser used by derivation.
  while (true) {
    const secret = randomBytes(32).toString("hex");
    try {
      deriveSubmissionHmacKeyCommitment(secret);
      return secret;
    } catch {
      // Vanishingly unlikely short-period random material is correctly rejected; try again.
    }
  }
}

function distinctRandomSecret(other: string): string {
  let secret = validRandomSecret();
  while (secret === other) secret = validRandomSecret();
  return secret;
}

function replaceHexDigit(value: string, index: number): string {
  const replacement = value[index] === "0" ? "1" : "0";
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function captureUnavailable(operation: () => void): SubmissionIntakeError {
  try {
    operation();
  } catch (error) {
    const submissionError = error as SubmissionIntakeError;
    expect(safeErrorShape(submissionError)).toEqual({
      code: "SUBMISSION_UNAVAILABLE",
      message: "SUBMISSION_UNAVAILABLE",
      name: "SubmissionIntakeError",
      status: 503,
    });
    return submissionError;
  }
  throw new Error("Expected key-pin verification to fail closed");
}

function expectUnavailable(operation: () => void, forbiddenValues: readonly (string | undefined)[]): void {
  const error = captureUnavailable(operation);
  const serialized = JSON.stringify(error);
  for (const value of forbiddenValues) {
    if (value) {
      expect(error.message).not.toContain(value);
      expect(serialized).not.toContain(value);
    }
  }
  expect(error).not.toHaveProperty("cause");
  expect(error.stack).not.toContain(forbiddenValues.filter(Boolean).join(""));
}

function safeErrorShape(error: SubmissionIntakeError) {
  return {
    code: error.code,
    message: error.message,
    name: error.name,
    status: error.status,
  };
}
