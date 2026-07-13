import { describe, expect, it } from "vitest";

import { resolveNoticeChannel } from "@/domain/notice-channel";

describe("notice channel configuration", () => {
  it("accepts an explicitly configured HTTPS notice form", () => {
    expect(resolveNoticeChannel("https://notices.example/report")).toEqual({
      configured: true,
      url: "https://notices.example/report",
    });
  });

  it.each([
    undefined,
    "",
    "http://notices.example/report",
    "https://user:secret@notices.example/report",
    "https://notices.example/report#urgent",
    " https://notices.example/report",
    "https://notices.example\\report",
    "mailto:invented@example.invalid",
  ])("fails closed for an absent or unsafe channel: %s", (value) => {
    expect(resolveNoticeChannel(value).configured).toBe(false);
  });
});
