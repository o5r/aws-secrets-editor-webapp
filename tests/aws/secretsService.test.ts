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

import { loadSecret, saveSecret, listVersions, loadVersion } from "../../src/aws/secretsService";
import { getSsoSession } from "../../src/aws/sessionStore";

const b64Encode = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const b64Decode = (s: string) => Buffer.from(s, "base64").toString("utf-8");

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
    it("extracts ALL_ORGANIZATIONS_SETTINGS from the full secret", async () => {
      const fullSecret = {
        ALL_ORGANIZATIONS_SETTINGS: b64Encode(JSON.stringify({ org1: { key: "val" } })),
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

    it("throws when ALL_ORGANIZATIONS_SETTINGS key is missing", async () => {
      mockSmSend.mockResolvedValue({
        SecretString: JSON.stringify({ SOME_OTHER_KEY: "value" }),
        VersionId: "v1",
      });

      await expect(loadSecret("123-Admin", "sess-1")).rejects.toThrow(
        'Key "ALL_ORGANIZATIONS_SETTINGS" not found'
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
    it("preserves other keys when updating ALL_ORGANIZATIONS_SETTINGS", async () => {
      const originalSecret = {
        ALL_ORGANIZATIONS_SETTINGS: b64Encode(JSON.stringify({ org1: { old: true } })),
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
      expect(JSON.parse(b64Decode(savedFull.ALL_ORGANIZATIONS_SETTINGS))).toEqual(newValue);
    });

    it("preserves single quotes in values without unicode escaping", async () => {
      const originalSecret = {
        ALL_ORGANIZATIONS_SETTINGS: b64Encode(JSON.stringify({ org1: { old: true } })),
      };

      mockSmSend
        .mockResolvedValueOnce({
          SecretString: JSON.stringify(originalSecret),
          VersionId: "v1",
        })
        .mockResolvedValueOnce({ VersionId: "v2" });

      const newValue = {
        org1: {
          label: "Création d'entreprise",
          loanObjects: [
            { code: "CRE.EN", label: "ENT-Création d'entreprise" },
            { code: "IMMEUB", label: "ENT-Immobilier professionnel d'exploitation" },
            { code: "TRAVAU", label: "ENT-Travaux d'aménagement professionnels" },
          ],
        },
      };

      await saveSecret("123-Admin", "sess-1", newValue);

      const putCall = mockSmSend.mock.calls[1][0];
      const secretString = putCall.input.SecretString;
      const savedFull = JSON.parse(secretString);
      const innerJson = b64Decode(savedFull.ALL_ORGANIZATIONS_SETTINGS);

      // Inner JSON must NOT contain \u0027 (escaped single quote)
      expect(innerJson).not.toContain("\\u0027");
      // Must contain literal single quotes
      expect(innerJson).toContain("d'entreprise");
      expect(innerJson).toContain("d'exploitation");
      expect(innerJson).toContain("d'aménagement");

      // Verify the saved value round-trips correctly
      const savedValue = JSON.parse(innerJson);
      expect(savedValue).toEqual(newValue);
    });

    it("preserves accented and special characters without unicode escaping", async () => {
      const originalSecret = {
        ALL_ORGANIZATIONS_SETTINGS: b64Encode(JSON.stringify({})),
      };

      mockSmSend
        .mockResolvedValueOnce({
          SecretString: JSON.stringify(originalSecret),
          VersionId: "v1",
        })
        .mockResolvedValueOnce({ VersionId: "v2" });

      const newValue = {
        org1: {
          label: "Données générales de l'établissement",
          description: "Réf. à vérifier — n°42",
        },
      };

      await saveSecret("123-Admin", "sess-1", newValue);

      const putCall = mockSmSend.mock.calls[1][0];
      const secretString = putCall.input.SecretString;
      const savedFull = JSON.parse(secretString);
      const innerJson = b64Decode(savedFull.ALL_ORGANIZATIONS_SETTINGS);

      // Inner JSON must not have unnecessary unicode escapes
      expect(innerJson).not.toMatch(/\\u00[0-9a-fA-F]{2}/);
      // Must contain the literal characters
      expect(innerJson).toContain("Données");
      expect(innerJson).toContain("générales");
      expect(innerJson).toContain("l'établissement");
      expect(innerJson).toContain("vérifier");

      // Round-trip check
      const savedValue = JSON.parse(innerJson);
      expect(savedValue).toEqual(newValue);
    });

    it("keeps mandatory JSON escapes (double quotes, backslashes, control chars)", async () => {
      const originalSecret = {
        ALL_ORGANIZATIONS_SETTINGS: b64Encode(JSON.stringify({})),
      };

      mockSmSend
        .mockResolvedValueOnce({
          SecretString: JSON.stringify(originalSecret),
          VersionId: "v1",
        })
        .mockResolvedValueOnce({ VersionId: "v2" });

      const newValue = {
        withQuote: 'value with "quotes"',
        withBackslash: "path\\to\\file",
        withNewline: "line1\nline2",
        withTab: "col1\tcol2",
      };

      await saveSecret("123-Admin", "sess-1", newValue);

      const putCall = mockSmSend.mock.calls[1][0];
      const secretString = putCall.input.SecretString;

      // Must still be valid JSON
      const savedFull = JSON.parse(secretString);
      const savedValue = JSON.parse(b64Decode(savedFull.ALL_ORGANIZATIONS_SETTINGS));
      expect(savedValue).toEqual(newValue);
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

    it("filters out versions without VersionId", async () => {
      mockSmSend.mockResolvedValue({
        Versions: [
          { VersionId: "v1", VersionStages: ["AWSCURRENT"] },
          { VersionStages: ["AWSPREVIOUS"] }, // no VersionId
        ],
      });

      const versions = await listVersions("123-Admin", "sess-1");
      expect(versions).toHaveLength(1);
    });

    it("handles empty versions list", async () => {
      mockSmSend.mockResolvedValue({ Versions: [] });
      const versions = await listVersions("123-Admin", "sess-1");
      expect(versions).toEqual([]);
    });
  });

  describe("loadVersion", () => {
    it("loads a specific version", async () => {
      const fullSecret = {
        ALL_ORGANIZATIONS_SETTINGS: b64Encode(JSON.stringify({ org1: { versioned: true } })),
      };

      mockSmSend.mockResolvedValue({
        SecretString: JSON.stringify(fullSecret),
        VersionId: "v-specific",
        VersionStages: ["AWSPREVIOUS"],
      });

      const result = await loadVersion("123-Admin", "sess-1", "v-specific");
      expect(result.value).toEqual({ org1: { versioned: true } });
      expect(result.versionId).toBe("v-specific");
      expect(result.versionStages).toEqual(["AWSPREVIOUS"]);
    });

    it("throws when version has no SecretString", async () => {
      mockSmSend.mockResolvedValue({
        SecretString: undefined,
        VersionId: "v1",
      });

      await expect(loadVersion("123-Admin", "sess-1", "v1")).rejects.toThrow(
        "Secret version has no string value"
      );
    });

    it("returns null value when key is missing in version", async () => {
      mockSmSend.mockResolvedValue({
        SecretString: JSON.stringify({ OTHER: "val" }),
        VersionId: "v1",
      });

      const result = await loadVersion("123-Admin", "sess-1", "v1");
      expect(result.value).toBeNull();
      expect(result.versionId).toBe("v1");
    });
  });

  describe("createSecretsManagerClient errors", () => {
    it("throws when no active SSO session", async () => {
      vi.mocked(getSsoSession).mockReturnValueOnce(undefined);

      await expect(loadSecret("123-Admin", "sess-1")).rejects.toThrow(
        "No active SSO session"
      );
    });

    it("throws when role credentials are missing", async () => {
      mockSsoSend.mockResolvedValueOnce({
        roleCredentials: {
          accessKeyId: undefined,
          secretAccessKey: undefined,
        },
      });

      await expect(loadSecret("123-Admin", "sess-1")).rejects.toThrow(
        "Failed to obtain role credentials via SSO"
      );
    });
  });

  describe("saveSecret errors", () => {
    it("throws when current secret has no string value", async () => {
      mockSmSend.mockResolvedValueOnce({
        SecretString: undefined,
      });

      await expect(saveSecret("123-Admin", "sess-1", {})).rejects.toThrow(
        "Secret has no string value"
      );
    });
  });
});
