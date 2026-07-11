import { describe, expect, it } from "vitest";
import { anonymousCanRead, type PublicRecordStatus } from "@/domain/public-access";

describe("anonymous catalogue access", () => {
  it.each([
    ["draft", false],
    ["in_review", false],
    ["published", true],
    ["needs_review", false],
    ["archived", false],
  ] satisfies Array<[PublicRecordStatus, boolean]>)("treats %s visibility as %s", (status, visible) => {
    expect(anonymousCanRead(status)).toBe(visible);
  });
});
