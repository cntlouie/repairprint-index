export type NoticeChannel = Readonly<
  | { configured: false; reason: "missing" | "invalid" }
  | { configured: true; url: string }
>;

export function resolveNoticeChannel(rawValue: string | undefined): NoticeChannel {
  if (!rawValue) return Object.freeze({ configured: false, reason: "missing" });
  if (rawValue !== rawValue.trim() || /[\u0000-\u001f\u007f\\]/u.test(rawValue)) {
    return Object.freeze({ configured: false, reason: "invalid" });
  }
  try {
    const parsed = new URL(rawValue);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.hash
      || parsed.origin === "null"
    ) {
      return Object.freeze({ configured: false, reason: "invalid" });
    }
    return Object.freeze({ configured: true, url: parsed.toString() });
  } catch {
    return Object.freeze({ configured: false, reason: "invalid" });
  }
}
