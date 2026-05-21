import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSmSend = vi.fn();
const mockSsoSend = vi.fn();

// Mock AWS SDK with proper class-like constructors
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = mockSmSend;
  },
  GetSecretValueCommand: class {
    constructor(public input: any) {}
  },
  PutSecretValueCommand: class {
    constructor(public input: any) {}
  },
  ListSecretVersionIdsCommand: class {
    constructor(public input: any) {}
  },
}));

vi.mock("@aws-sdk/client-sso", () => ({
  SSOClient: class {
    send = mockSsoSend;
  },
  GetRoleCredentialsCommand: class {
    constructor(public input: any) {}
  },
}));

vi.mock("../../src/aws/sessionStore", () => ({
  getSsoSession: vi.fn(() => ({
    ssoSession: "test",
    ssoRegion: "eu-west-1",
    accessToken: "token",
  })),
}));

vi.mock("../../src/aws/envConfig", () => ({
  getEnvironment: vi.fn(() => ({
    id: "123-Admin",
    label: "sandbox (Admin)",
    accountName: "sandbox",
    regions: ["eu-west-1"],
    ssoAccountId: "123456789012",
    ssoRoleName: "Admin",
  })),
}));

import { loadSecret, saveSecret, listVersions } from "../../src/aws/secretsService";

describe("secretsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default SSO mock: return role credentials
    mockSsoSend.mockResolvedValue({
      roleCredentials: {
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "secret_test",
        sessionToken: "token_test",
      },
    });
  });

  describe("loadSecret", () => {
    it("extracts ALL_ORGANIZATION_SETTINGS from the full secret", async () => {
      const fullSecret = {
        ALL_ORGANIZATION_SETTINGS: JSON.stringify({ org1: { key: "val" } }),
        OTHER_KEY: "other_value",
      };

      mockSmSend.mockResolvedValue({
        SecretString: JSON.stringify(fullSecret),
        VersionId: "v1",
        VersionStages: ["AWSCURRENT"],
      });

      const result = await loadSecret("123-Admin", "sess-1");

      expect(result.value).toEqual({ org1: { key: "val" } });
      expect(result.versionId).toBe("v1");
    });

    it("throws when ALL_ORGANIZATION_SETTINGS key is missing", async () => {
      mockSmSend.mockResolvedValue({
        SecretString: JSON.stringify({ SOME_OTHER_KEY: "value" }),
        VersionId: "v1",
      });

      await expect(loadSecret("123-Admin", "sess-1")).rejects.toThrow(
        'Key "ALL_ORGANIZATION_SETTINGS" not found'
      );
    });

    it("throws when SecretString is empty", async () => {
      mockSmSend.mockResolvedValue({
        SecretString: undefined,
        VersionId: "v1",
      });

      await expect(loadSecret("123-Admin", "sess-1")).rejects.toThrow(
        "Secret has no string value"
      );
    });
  });

  describe("saveSecret", () => {
    it("preserves other keys when updating ALL_ORGANIZATION_SETTINGS", async () => {
      const originalSecret = {
        ALL_ORGANIZATION_SETTINGS: JSON.stringify({ org1: { old: true } }),
        OTHER_KEY: "must_be_preserved",
        ANOTHER_KEY: "also_preserved",
      };

      // First call: GetSecretValue (read current), second call: PutSecretValue
      mockSmSend
        .mockResolvedValueOnce({
          SecretString: JSON.stringify(originalSecret),
          VersionId: "v1",
        })
        .mockResolvedValueOnce({
          VersionId: "v2",
        });

      const newValue = { org1: { new: true } };
      const result = await saveSecret("123-Admin", "sess-1", newValue);

      expect(result.versionId).toBe("v2");

      // Verify the PutSecretValue call preserved other keys
      const putCall = mockSmSend.mock.calls[1][0];
      const savedFull = JSON.parse(putCall.input.SecretString);
      expect(savedFull.OTHER_KEY).toBe("must_be_preserved");
      expect(savedFull.ANOTHER_KEY).toBe("also_preserved");
      expect(JSON.parse(savedFull.ALL_ORGANIZATION_SETTINGS)).toEqual(newValue);
    });
  });

  describe("listVersions", () => {
    it("returns sorted versions", async () => {
      mockSmSend.mockResolvedValue({
        Versions: [
          {
            VersionId: "v1",
            CreatedDate: new Date("2024-01-01"),
            VersionStages: ["AWSPREVIOUS"],
          },
          {
            VersionId: "v2",
            CreatedDate: new Date("2024-06-01"),
            VersionStages: ["AWSCURRENT"],
          },
        ],
      });

      const versions = await listVersions("123-Admin", "sess-1");

      expect(versions).toHaveLength(2);
      expect(versions[0].versionId).toBe("v2"); // Most recent first
      expect(versions[1].versionId).toBe("v1");
    });
  });
});
