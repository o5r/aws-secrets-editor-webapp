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
  // Match the whole run of backslashes preceding `uXXXX`. Only an odd-length
  // run means the trailing backslash actually starts an escape sequence; an
  // even-length run is made of escaped literal backslashes (e.g. the value
  // contained the text `\u00e9`), and rewriting it would produce broken JSON.
  return jsonString.replace(
    /(\\+)u([0-9a-fA-F]{4})/g,
    (match, slashes: string, hex: string) => {
      if (slashes.length % 2 === 0) {
        return match;
      }
      const code = parseInt(hex, 16);
      // Keep escapes for characters that must be escaped in JSON:
      // " (0x22), \ (0x5C), and control characters (0x00-0x1F)
      if (code <= 0x1f || code === 0x22 || code === 0x5c) {
        return match;
      }
      // Lone surrogates cannot be represented as UTF-8 text; leave them escaped.
      if (code >= 0xd800 && code <= 0xdfff) {
        return match;
      }
      return slashes.slice(0, -1) + String.fromCodePoint(code);
    }
  );
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

/**
 * How ALL_ORGANIZATIONS_SETTINGS is stored in a given secret. Older accounts
 * (e.g. `production`) keep it as a plain JSON string; newer ones base64-encode
 * it. Both must be supported, and — critically — the original form must be
 * preserved on save so that editing one key never silently migrates the format
 * for every consumer of the secret.
 */
export type SettingsEncoding = "base64" | "plain";

/**
 * Determine how a stored value is encoded. Base64 output never starts with `{`
 * or `[`, so a leading JSON opener is an unambiguous marker of the plain form.
 */
export function detectSettingsEncoding(raw: string): SettingsEncoding {
  const trimmed = raw.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "plain" : "base64";
}

/**
 * Decode a stored value in whichever form it happens to use, reporting the
 * encoding so the caller can round-trip it unchanged.
 */
export function decodeStoredSettings(raw: string): {
  value: unknown;
  encoding: SettingsEncoding;
} {
  const encoding = detectSettingsEncoding(raw);

  if (encoding === "plain") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Value is empty");
    }
    try {
      return { value: JSON.parse(trimmed), encoding };
    } catch (err) {
      throw new Error(`Value is not valid JSON: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  return { value: decodeSettings(raw), encoding };
}

/** Re-encode a value using the encoding it was originally stored with. */
export function encodeStoredSettings(
  value: unknown,
  encoding: SettingsEncoding
): string {
  return encoding === "plain"
    ? serializeSettings(value)
    : encodeSettings(value);
}

/** Strip whitespace and normalize padding so two base64 strings are comparable. */
function normalizeBase64(input: string): string {
  const compact = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const withoutPadding = compact.replace(/=+$/, "");
  const padding = (4 - (withoutPadding.length % 4)) % 4;
  return withoutPadding + "=".repeat(padding);
}
