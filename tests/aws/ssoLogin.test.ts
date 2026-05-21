import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOidcSend = vi.fn();

vi.mock("@aws-sdk/client-sso-oidc", () => ({
  SSOOIDCClient: class {
    send = mockOidcSend;
  },
  RegisterClientCommand: class {
    constructor(public input: any) {}
  },
  StartDeviceAuthorizationCommand: class {
    constructor(public input: any) {}
  },
  CreateTokenCommand: class {
    constructor(public input: any) {}
  },
}));

vi.mock("../../src/aws/ssoProfiles", () => ({
  loadSsoProfiles: vi.fn(() => [
    {
      name: "test-profile",
      displayName: "Test",
      ssoStartUrl: "https://start.example.com",
      ssoRegion: "eu-west-1",
      ssoAccountId: "111111111111",
      ssoRoleName: "Admin",
      ssoSession: "test-sso",
    },
  ]),
}));

vi.mock("../../src/aws/sessionStore", () => ({
  setSsoSession: vi.fn(),
}));

import { startLogin, pollForLogin } from "../../src/aws/ssoLogin";
import { setSsoSession } from "../../src/aws/sessionStore";

describe("ssoLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("startLogin", () => {
    it("throws for unknown profile", async () => {
      await expect(startLogin("nonexistent")).rejects.toThrow(
        "Unknown SSO profile: nonexistent"
      );
    });

    it("registers client and starts device auth", async () => {
      mockOidcSend
        .mockResolvedValueOnce({
          clientId: "client-id",
          clientSecret: "client-secret",
        })
        .mockResolvedValueOnce({
          deviceCode: "device-123",
          verificationUriComplete: "https://verify.example.com?code=ABCD",
          userCode: "ABCD-1234",
          interval: 5,
          expiresIn: 600,
        });

      const result = await startLogin("test-profile");
      expect(result.deviceCode).toBe("device-123");
      expect(result.verificationUri).toBe("https://verify.example.com?code=ABCD");
      expect(result.userCode).toBe("ABCD-1234");
      expect(result.intervalSeconds).toBe(5);
    });

    it("throws when register client fails", async () => {
      // Reset module to clear cached registeredClient
      vi.resetModules();
      const mod = await import("../../src/aws/ssoLogin");

      mockOidcSend.mockResolvedValueOnce({
        clientId: undefined,
        clientSecret: undefined,
      });

      await expect(mod.startLogin("test-profile")).rejects.toThrow(
        "Failed to register SSO OIDC client"
      );
    });

    it("throws on incomplete device auth response", async () => {
      // Client already cached from earlier test, so only need device auth mock
      mockOidcSend.mockResolvedValueOnce({
        deviceCode: "dev-code",
        // missing verificationUriComplete, userCode, interval, expiresIn
      });

      await expect(startLogin("test-profile")).rejects.toThrow(
        "Incomplete device authorization response"
      );
    });
  });

  describe("pollForLogin", () => {
    // Client is already registered from startLogin tests above (module-level cache)

    it("throws for unknown profile", async () => {
      await expect(pollForLogin("nonexistent", "code", "sess")).rejects.toThrow(
        "Unknown SSO profile: nonexistent"
      );
    });

    it("returns pending when AuthorizationPendingException", async () => {
      const err = new Error("auth pending");
      (err as any).name = "AuthorizationPendingException";
      mockOidcSend.mockRejectedValueOnce(err);

      const result = await pollForLogin("test-profile", "code", "sess");
      expect(result).toEqual({ success: false, pending: true });
    });

    it("returns pending on authorization_pending error", async () => {
      const err = new Error("pending");
      (err as any).error = "authorization_pending";
      mockOidcSend.mockRejectedValueOnce(err);

      const result = await pollForLogin("test-profile", "code", "sess");
      expect(result).toEqual({ success: false, pending: true });
    });

    it("rethrows non-pending errors", async () => {
      mockOidcSend.mockRejectedValueOnce(new Error("network error"));

      await expect(
        pollForLogin("test-profile", "code", "sess")
      ).rejects.toThrow("network error");
    });

    it("returns success and stores session on valid token", async () => {
      mockOidcSend.mockResolvedValueOnce({
        accessToken: "token-xyz",
        expiresIn: 3600,
      });

      const result = await pollForLogin("test-profile", "code", "sess-1");
      expect(result).toEqual({ success: true });
      expect(setSsoSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
        accessToken: "token-xyz",
        ssoSession: "test-sso",
        ssoRegion: "eu-west-1",
      }));
    });

    it("throws when token response is incomplete", async () => {
      mockOidcSend.mockResolvedValueOnce({
        accessToken: undefined,
        expiresIn: undefined,
      });

      await expect(
        pollForLogin("test-profile", "code", "sess")
      ).rejects.toThrow("Failed to obtain SSO access token");
    });
  });
});
