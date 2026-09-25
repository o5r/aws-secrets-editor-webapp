import { describe, it, expect } from "vitest";
// The browser implementation relies only on atob/btoa/TextEncoder/TextDecoder,
// all of which exist in Node, so it can be imported and compared directly.
import * as browser from "../../public/secretCodec.js";
import * as node from "../../src/shared/secretCodec";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

const SAMPLES: unknown[] = [
  { a: 1 },
  { name: "café", quote: "it's", path: "a\\b", nl: "line1\nline2" },
  { nested: { list: [1, "two", null, true], empty: {} } },
  { emoji: "🚀", cjk: "日本語" },
  [],
];

describe("browser/node codec parity", () => {
  it("serializes identically", () => {
    for (const sample of SAMPLES) {
      expect(browser.serializeSettings(sample)).toBe(
        node.serializeSettings(sample)
      );
    }
  });

  it("encodes identically", () => {
    for (const sample of SAMPLES) {
      expect(browser.encodeSettings(sample)).toBe(node.encodeSettings(sample));
    }
  });

  it("decodes identically", () => {
    for (const sample of SAMPLES) {
      const encoded = node.encodeSettings(sample);
      expect(browser.decodeSettings(encoded)).toEqual(
        node.decodeSettings(encoded)
      );
    }
  });

  it("round-trips a canonical payload byte-for-byte in the browser impl", () => {
    const encoded = b64('{"name":"café","quote":"it\'s","emoji":"🚀"}');
    expect(browser.encodeSettings(browser.decodeSettings(encoded))).toBe(
      encoded
    );
  });

  it("both reject empty input", () => {
    expect(() => browser.decodeSettings("  ")).toThrow(/empty/i);
    expect(() => node.decodeSettings("  ")).toThrow(/empty/i);
  });

  it("both reject non-base64 input", () => {
    expect(() => browser.decodeSettings("not base64 !!!")).toThrow(/base64/i);
    expect(() => node.decodeSettings("not base64 !!!")).toThrow(/base64/i);
  });

  it("both reject base64 that is not JSON", () => {
    expect(() => browser.decodeSettings(b64("plain text"))).toThrow(
      /not valid JSON/i
    );
    expect(() => node.decodeSettings(b64("plain text"))).toThrow(
      /not valid JSON/i
    );
  });

  it("browser impl tolerates whitespace in the pasted value", () => {
    const encoded = b64('{"a":1}');
    expect(browser.decodeSettings(`${encoded.slice(0, 3)}\n ${encoded.slice(3)}`))
      .toEqual({ a: 1 });
  });
});
