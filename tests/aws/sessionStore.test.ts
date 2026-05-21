import { describe, it, expect, beforeEach } from "vitest";
import { setSsoSession, getSsoSession } from "../../src/aws/sessionStore";

describe("sessionStore", () => {
  beforeEach(() => {
    // Set a valid session for tests
    setSsoSession("valid-session", {
      ssoSession: "test",
      ssoRegion: "eu-west-1",
      accessToken: "token-abc",
      expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour from now
    });
  });

  describe("setSsoSession / getSsoSession", () => {
    it("stores and retrieves a session", () => {
      const session = getSsoSession("valid-session");
      expect(session).toBeDefined();
      expect(session!.accessToken).toBe("token-abc");
      expect(session!.ssoRegion).toBe("eu-west-1");
    });

    it("returns undefined for unknown session", () => {
      expect(getSsoSession("unknown")).toBeUndefined();
    });

    it("returns undefined for expired session", () => {
      setSsoSession("expired", {
        ssoSession: "test",
        ssoRegion: "eu-west-1",
        accessToken: "expired-token",
        expiresAt: new Date(Date.now() - 1000), // already expired
      });
      expect(getSsoSession("expired")).toBeUndefined();
    });

    it("returns session when expiresAt is undefined", () => {
      setSsoSession("no-expiry", {
        ssoSession: "test",
        ssoRegion: "eu-west-1",
        accessToken: "no-expiry-token",
      });
      const session = getSsoSession("no-expiry");
      expect(session).toBeDefined();
      expect(session!.accessToken).toBe("no-expiry-token");
    });
  });
});
