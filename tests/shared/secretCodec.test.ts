import { describe, it, expect } from "vitest";
import {
  decodeSettings,
  decodeUnicodeEscapes,
  encodeSettings,
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
});

describe("serializeSettings", () => {
  it("produces compact JSON with literal non-ASCII characters", () => {
    expect(serializeSettings({ name: "café", quote: "it's" })).toBe(
      '{"name":"café","quote":"it\'s"}'
    );
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
