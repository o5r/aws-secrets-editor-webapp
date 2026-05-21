import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/server";

// Mock all AWS modules
vi.mock("../../src/aws/ssoProfiles", () => ({
  loadSsoProfiles: vi.fn(() => [
    {
      name: "test-profile",
      displayName: "Test Profile",
      ssoStartUrl: "https://start.example.com",
      ssoRegion: "eu-west-1",
      ssoAccountId: "123456789012",
      ssoRoleName: "Admin",
      ssoSession: "test-session",
    },
  ]),
}));

vi.mock("../../src/aws/ssoLogin", () => ({
  startLogin: vi.fn(),
  pollForLogin: vi.fn(),
}));

vi.mock("../../src/aws/ssoDiscovery", () => ({
  discoverSsoEnvironments: vi.fn(),
}));

vi.mock("../../src/aws/sessionStore", () => ({
  getSsoSession: vi.fn(),
}));

vi.mock("../../src/aws/secretsService", () => ({
  loadSecret: vi.fn(),
  saveSecret: vi.fn(),
  listVersions: vi.fn(),
  loadVersion: vi.fn(),
}));

vi.mock("../../src/aws/envConfig", () => ({
  registerDynamicEnvironments: vi.fn(),
  getEnvironment: vi.fn(() => ({
    id: "123-Admin",
    label: "sandbox (Admin)",
    accountName: "sandbox",
    regions: ["eu-west-1"],
    ssoAccountId: "123456789012",
    ssoRoleName: "Admin",
  })),
}));

import { startLogin, pollForLogin } from "../../src/aws/ssoLogin";
import { discoverSsoEnvironments } from "../../src/aws/ssoDiscovery";
import { getSsoSession } from "../../src/aws/sessionStore";
import {
  loadSecret,
  saveSecret,
  listVersions,
  loadVersion,
} from "../../src/aws/secretsService";

describe("API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /api/sso-profiles", () => {
    it("returns SSO profiles", async () => {
      const res = await request(app).get("/api/sso-profiles");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("test-profile");
    });
  });

  describe("POST /api/sso/login/start", () => {
    it("returns 400 without profileName", async () => {
      const res = await request(app).post("/api/sso/login/start").send({});
      expect(res.status).toBe(400);
    });

    it("starts login flow", async () => {
      vi.mocked(startLogin).mockResolvedValue({
        deviceCode: "code-123",
        verificationUri: "https://verify.example.com",
        userCode: "ABCD-1234",
        intervalSeconds: 5,
        expiresAt: new Date(),
      });

      const res = await request(app)
        .post("/api/sso/login/start")
        .send({ profileName: "test-profile" });

      expect(res.status).toBe(200);
      expect(res.body.deviceCode).toBe("code-123");
    });
  });

  describe("POST /api/sso/login/poll", () => {
    it("returns 400 without required fields", async () => {
      const res = await request(app).post("/api/sso/login/poll").send({});
      expect(res.status).toBe(400);
    });

    it("polls login", async () => {
      vi.mocked(pollForLogin).mockResolvedValue({ success: true });

      const res = await request(app).post("/api/sso/login/poll").send({
        profileName: "test-profile",
        deviceCode: "code-123",
        sessionId: "sess-1",
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("GET /api/sso/environments", () => {
    it("returns 400 without sessionId", async () => {
      const res = await request(app).get("/api/sso/environments");
      expect(res.status).toBe(400);
    });

    it("returns 401 without active session", async () => {
      vi.mocked(getSsoSession).mockReturnValue(undefined);
      const res = await request(app).get("/api/sso/environments?sessionId=bad");
      expect(res.status).toBe(401);
    });

    it("returns environments", async () => {
      vi.mocked(getSsoSession).mockReturnValue({
        ssoSession: "test",
        ssoRegion: "eu-west-1",
        accessToken: "token",
      });
      vi.mocked(discoverSsoEnvironments).mockResolvedValue([
        {
          id: "123-Admin",
          label: "sandbox (Admin)",
          accountName: "sandbox",
          regions: ["eu-west-1"],
          ssoAccountId: "123",
          ssoRoleName: "Admin",
        },
      ]);

      const res = await request(app).get("/api/sso/environments?sessionId=sess-1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe("GET /api/secret", () => {
    it("returns 400 without params", async () => {
      const res = await request(app).get("/api/secret");
      expect(res.status).toBe(400);
    });

    it("loads secret", async () => {
      vi.mocked(loadSecret).mockResolvedValue({
        value: { org1: { setting: "value" } },
        versionId: "v1",
        versionStages: ["AWSCURRENT"],
      });

      const res = await request(app).get("/api/secret?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(200);
      expect(res.body.value).toEqual({ org1: { setting: "value" } });
      expect(res.body.environment).toBe("sandbox");
    });
  });

  describe("PUT /api/secret", () => {
    it("returns 400 without required fields", async () => {
      const res = await request(app).put("/api/secret").send({});
      expect(res.status).toBe(400);
    });

    it("saves secret", async () => {
      vi.mocked(saveSecret).mockResolvedValue({ versionId: "v2" });

      const res = await request(app).put("/api/secret").send({
        envId: "123-Admin",
        sessionId: "sess-1",
        value: { org1: { setting: "newvalue" } },
      });

      expect(res.status).toBe(200);
      expect(res.body.versionId).toBe("v2");
      expect(res.body.message).toBe("Secret updated successfully");
    });
  });

  describe("GET /api/secret/versions", () => {
    it("returns versions", async () => {
      vi.mocked(listVersions).mockResolvedValue([
        { versionId: "v1", versionStages: ["AWSCURRENT"] },
      ]);

      const res = await request(app).get("/api/secret/versions?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(200);
      expect(res.body.versions).toHaveLength(1);
    });
  });

  describe("GET /api/secret/version/:versionId", () => {
    it("loads specific version", async () => {
      vi.mocked(loadVersion).mockResolvedValue({
        value: { org1: {} },
        versionId: "v1",
        versionStages: ["AWSPREVIOUS"],
      });

      const res = await request(app).get("/api/secret/version/v1?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(200);
      expect(res.body.versionId).toBe("v1");
    });
  });
});
