/**
 * Browser mirror of src/shared/secretCodec.ts.
 *
 * Local mode runs entirely client-side so the pasted secret never reaches the
 * server. The transformation MUST stay byte-identical to the Node version,
 * otherwise a value round-tripped locally would differ from what the AWS save
 * path would have written. Any change here must be mirrored in
 * src/shared/secretCodec.ts (and covered by tests/shared/secretCodec.test.ts).
 */

/**
 * Decode unnecessary \uXXXX escapes in a JSON string.
 * JSON.stringify may encode characters like ' as \u0027, which is valid JSON
 * but changes the byte representation compared to the original value.
 * Escapes are kept for characters that MUST be escaped in JSON (" \ and
 * control characters).
 */
export function decodeUnicodeEscapes(jsonString) {
  // Match the whole run of backslashes preceding `uXXXX`. Only an odd-length
  // run means the trailing backslash actually starts an escape sequence; an
  // even-length run is made of escaped literal backslashes (e.g. the value
  // contained the text `\u00e9`), and rewriting it would produce broken JSON.
  return jsonString.replace(/(\\+)u([0-9a-fA-F]{4})/g, (match, slashes, hex) => {
    if (slashes.length % 2 === 0) {
      return match;
    }
    const code = parseInt(hex, 16);
    if (code <= 0x1f || code === 0x22 || code === 0x5c) {
      return match;
    }
    // Lone surrogates cannot be represented as UTF-8 text; leave them escaped.
    if (code >= 0xd800 && code <= 0xdfff) {
      return match;
    }
    return slashes.slice(0, -1) + String.fromCodePoint(code);
  });
}

/** base64 -> UTF-8 string. Throws on malformed input. */
export function decodeBase64Value(encoded) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** UTF-8 string -> base64. */
export function encodeBase64Value(raw) {
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  // Chunked to avoid blowing the argument limit of String.fromCharCode
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Canonical serialization applied before base64-encoding. */
export function serializeSettings(value) {
  return decodeUnicodeEscapes(JSON.stringify(value));
}

/** Full decode pipeline: base64 -> parsed JSON value. */
export function decodeSettings(encoded) {
  const trimmed = (encoded || "").trim();
  if (!trimmed) {
    throw new Error("Value is empty");
  }

  // atob rejects whitespace, so strip it first (values are often pasted wrapped)
  const compact = trimmed.replace(/\s+/g, "");

  let json;
  try {
    json = decodeBase64Value(compact);
  } catch {
    throw new Error("Value is not valid base64, or is not UTF-8 text");
  }

  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`Decoded value is not valid JSON: ${err.message}`, {
      cause: err,
    });
  }
}

/** Full encode pipeline: parsed JSON value -> base64. */
export function encodeSettings(value) {
  return encodeBase64Value(serializeSettings(value));
}

/**
 * How ALL_ORGANIZATIONS_SETTINGS is stored in a given secret: older accounts
 * keep it as a plain JSON string, newer ones base64-encode it. Base64 output
 * never starts with `{` or `[`, so a leading JSON opener is an unambiguous
 * marker of the plain form.
 */
export function detectSettingsEncoding(raw) {
  const trimmed = (raw || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "plain" : "base64";
}

/** Decode a stored value in whichever form it uses, reporting the encoding. */
export function decodeStoredSettings(raw) {
  const encoding = detectSettingsEncoding(raw);

  if (encoding === "plain") {
    const trimmed = (raw || "").trim();
    if (!trimmed) {
      throw new Error("Value is empty");
    }
    try {
      return { value: JSON.parse(trimmed), encoding };
    } catch (err) {
      throw new Error(`Value is not valid JSON: ${err.message}`, { cause: err });
    }
  }

  return { value: decodeSettings(raw), encoding };
}

/** Re-encode a value using the encoding it was originally stored with. */
export function encodeStoredSettings(value, encoding) {
  return encoding === "plain" ? serializeSettings(value) : encodeSettings(value);
}
