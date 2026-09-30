import { describe, it, expect } from "vitest";
import {
  decodeSettings,
  decodeStoredSettings,
  decodeUnicodeEscapes,
  detectSettingsEncoding,
  encodeSettings,
  encodeStoredSettings,
  serializeSettings,
} from "../../src/shared/secretCodec";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("decodeUnicodeEscapes", () => {
  it("unescapes characters that do not need escaping", () => {
    expect(decodeUnicodeEscapes('"it\\u0027s"')).toBe('"it\'s"');
    expect(decodeUnicodeEscapes('"caf\\u00e9"')).toBe('"café"');
  });

  it("keeps escapes that are mandatory in JSON", () => {
    expect(decodeUnicodeEscapes('"a\\u0022b"')).toBe('"a\\u0022b"');
    expect(decodeUnicodeEscapes('"a\\u005cb"')).toBe('"a\\u005cb"');
    expect(decodeUnicodeEscapes('"a\\u0000b"')).toBe('"a\\u0000b"');
    expect(decodeUnicodeEscapes('"a\\u001fb"')).toBe('"a\\u001fb"');
  });

  it("leaves a string without escapes untouched", () => {
    expect(decodeUnicodeEscapes('{"a":1}')).toBe('{"a":1}');
  });

  it("does not rewrite an escaped literal backslash followed by uXXXX", () => {
    // Source value is the 6-character text: \u00e9
    expect(decodeUnicodeEscapes('"\\\\u00e9"')).toBe('"\\\\u00e9"');
  });

  it("still unescapes after an escaped literal backslash", () => {
    expect(decodeUnicodeEscapes('"\\\\\\u00e9"')).toBe('"\\\\é"');
  });

  it("keeps lone surrogates escaped", () => {
    expect(decodeUnicodeEscapes('"\\ud800"')).toBe('"\\ud800"');
  });
});

describe("serializeSettings", () => {
  it("produces compact JSON with literal non-ASCII characters", () => {
    expect(serializeSettings({ name: "café", quote: "it's" })).toBe(
      '{"name":"café","quote":"it\'s"}'
    );
  });

  it("stays parseable when values contain literal backslashes", () => {
    const value = {
      winPath: "C:\\users\\test",
      literal: "text \\u00e9 text",
      pem: "-----BEGIN-----\\nabc",
    };
    const json = serializeSettings(value);
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe("encodeSettings / decodeSettings", () => {
  it("round-trips a value without altering it", () => {
    const value = { a: 1, b: ["x", "y"], c: { d: true, e: null } };
    expect(decodeSettings(encodeSettings(value))).toEqual(value);
  });

  it("round-trips a canonical base64 payload byte-for-byte", () => {
    const encoded = b64('{"name":"café","quote":"it\'s","n":1}');
    expect(encodeSettings(decodeSettings(encoded))).toBe(encoded);
  });

  it("round-trips multi-byte and emoji content", () => {
    const encoded = b64('{"a":"日本語 🚀"}');
    expect(encodeSettings(decodeSettings(encoded))).toBe(encoded);
  });

  it("tolerates whitespace in the pasted value", () => {
    const encoded = b64('{"a":1}');
    const wrapped = `${encoded.slice(0, 4)}\n  ${encoded.slice(4)}\n`;
    expect(decodeSettings(wrapped)).toEqual({ a: 1 });
  });

  it("normalizes non-canonical formatting rather than corrupting it", () => {
    // Pretty-printed input decodes fine, but re-encoding is compact
    const pretty = b64('{\n  "a": 1\n}');
    const value = decodeSettings(pretty);
    expect(value).toEqual({ a: 1 });
    expect(encodeSettings(value)).toBe(b64('{"a":1}'));
  });

  it("rejects an empty value", () => {
    expect(() => decodeSettings("   ")).toThrow(/empty/i);
  });

  it("rejects a value that is not base64", () => {
    expect(() => decodeSettings("not base64 !!!")).toThrow(/base64/i);
  });

  it("rejects base64 that does not decode to JSON", () => {
    expect(() => decodeSettings(b64("plain text"))).toThrow(/not valid JSON/i);
  });
});

describe("stored encoding detection", () => {
  // Matches what `production/marketplace/elasticbeanstalk/secrets` stores.
  const plain = '{"contractualObject":"ENT-Cr\\u00e9ation d\\u0027entreprise"}';

  it("detects plain JSON and base64", () => {
    expect(detectSettingsEncoding(plain)).toBe("plain");
    expect(detectSettingsEncoding(`  \n${plain}`)).toBe("plain");
    expect(detectSettingsEncoding(b64('{"a":1}'))).toBe("base64");
  });

  it("decodes a plain-JSON payload instead of mangling it as base64", () => {
    const { value, encoding } = decodeStoredSettings(plain);
    expect(encoding).toBe("plain");
    expect(value).toEqual({ contractualObject: "ENT-Création d'entreprise" });
  });

  it("decodes a base64 payload", () => {
    const { value, encoding } = decodeStoredSettings(b64('{"a":1}'));
    expect(encoding).toBe("base64");
    expect(value).toEqual({ a: 1 });
  });

  it("preserves the original encoding on re-encode", () => {
    const fromPlain = decodeStoredSettings(plain);
    expect(encodeStoredSettings(fromPlain.value, fromPlain.encoding)).toBe(
      '{"contractualObject":"ENT-Création d\'entreprise"}'
    );

    const encoded = b64('{"a":1}');
    const fromB64 = decodeStoredSettings(encoded);
    expect(encodeStoredSettings(fromB64.value, fromB64.encoding)).toBe(encoded);
  });

  it("produces a plain payload that survives nesting in the outer secret", () => {
    const { value, encoding } = decodeStoredSettings(plain);
    const outer = { ALL_ORGANIZATIONS_SETTINGS: encodeStoredSettings(value, encoding) };
    const secretString = serializeSettings(outer);
    expect(() => JSON.parse(secretString)).not.toThrow();
    expect(
      decodeStoredSettings(JSON.parse(secretString).ALL_ORGANIZATIONS_SETTINGS).value
    ).toEqual(value);
  });

  it("reports invalid plain JSON clearly", () => {
    expect(() => decodeStoredSettings('{"a":')).toThrow(/not valid JSON/i);
  });
});
