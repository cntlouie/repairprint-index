const exactHexKeyPattern = /^[0-9a-f]{64}$/iu;
const placeholderPattern = /change[\s_-]*me|dummy|example|placeholder|test/iu;

export function parseStrongHmacSecret(secret: string | undefined): Buffer {
  if (typeof secret !== "string" || !exactHexKeyPattern.test(secret)) throw new Error("HMAC_SECRET_INVALID");
  const key = Buffer.from(secret, "hex");
  if (key.byteLength !== 32 || hasShortRepeatingBytePattern(key) || placeholderPattern.test(key.toString("utf8"))) {
    throw new Error("HMAC_SECRET_INVALID");
  }
  return key;
}

function hasShortRepeatingBytePattern(key: Buffer): boolean {
  for (let period = 1; period <= key.byteLength / 2; period += 1) {
    if (key.byteLength % period === 0 && key.every((byte, index) => byte === key[index % period])) return true;
  }
  return false;
}
