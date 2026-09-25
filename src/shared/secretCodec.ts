/**
 * Encoding/decoding helpers for the ALL_ORGANIZATIONS_SETTINGS payload.
 *
 * This module is intentionally AWS-agnostic: the exact same transformation is
 * used by the AWS path (src/aws/secretsService.ts) and by the offline "local
 * mode" of the webapp (public/secretCodec.js). Any change here MUST be mirrored
 * in the browser implementation, otherwise a value round-tripped locally would
 * no longer be byte-identical to what the AWS path produces.
 */

/**
 * Decode unnecessary \uXXXX escapes in a JSON string.
 * JSON.stringify may encode characters like ' as \u0027, which is valid JSON
 * but changes the byte representation compared to the original value.
 * This replaces Unicode escapes with their literal characters, except for
 * characters that MUST be escaped in JSON strings (" \ and control chars).
 */
export function decodeUnicodeEscapes(jsonString: string): string {
  return jsonString.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
    const code = parseInt(hex, 16);
    // Keep escapes for characters that must be escaped in JSON:
    // " (0x22), \ (0x5C), and control characters (0x00-0x1F)
    if (code <= 0x1f || code === 0x22 || code === 0x5c) {
      return match;
    }
    return String.fromCodePoint(code);
  });
}

/**
 * The ALL_ORGANIZATIONS_SETTINGS value stored in AWS Secrets Manager is a
 * base64-encoded UTF-8 JSON string. Decode it to the original JSON string.
 */
export function decodeBase64Value(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf-8");
}

/**
 * Encode a UTF-8 JSON string as base64 before storing it in the secret map.
 */
export function encodeBase64Value(raw: string): string {
  return Buffer.from(raw, "utf-8").toString("base64");
}

/**
 * Serialize a parsed settings object back to the exact string representation
 * that gets base64-encoded. Single source of truth for both the AWS save path
 * and local mode.
 */
export function serializeSettings(value: unknown): string {
  return decodeUnicodeEscapes(JSON.stringify(value));
}

/**
 * Full decode pipeline: base64 string -> parsed JSON value.
 * Throws a descriptive error when the input is not valid base64 or not JSON.
 */
export function decodeSettings(encoded: string): unknown {
  const trimmed = encoded.trim();
  if (!trimmed) {
    throw new Error("Value is empty");
  }

  let json: string;
  try {
    json = decodeBase64Value(trimmed);
  } catch {
    throw new Error("Value is not valid base64");
  }

  // Buffer.from is lenient: it silently drops invalid characters instead of
  // throwing. Re-encoding and comparing catches genuinely malformed input.
  if (encodeBase64Value(json) !== normalizeBase64(trimmed)) {
    throw new Error("Value is not valid base64");
  }

  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Decoded value is not valid JSON: ${(err as Error).message}`,
      { cause: err }
    );
  }
}

/**
 * Full encode pipeline: parsed JSON value -> base64 string.
 */
export function encodeSettings(value: unknown): string {
  return encodeBase64Value(serializeSettings(value));
}

/** Strip whitespace and normalize padding so two base64 strings are comparable. */
function normalizeBase64(input: string): string {
  const compact = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const withoutPadding = compact.replace(/=+$/, "");
  const padding = (4 - (withoutPadding.length % 4)) % 4;
  return withoutPadding + "=".repeat(padding);
}
