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

vi.mock("../../src/aws/ecsService", () => ({
  discoverMarketplaceApiServices: vi.fn(),
  restartMarketplaceApi: vi.fn(),
  getDeploymentStatus: vi.fn(),
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
import {
  discoverMarketplaceApiServices,
  restartMarketplaceApi,
  getDeploymentStatus,
} from "../../src/aws/ecsService";

/** Build an EcsServiceInfo-shaped fixture for the given role. */
function svc(role: "web" | "worker" | "cron") {
  return {
    cluster: "marketplace-sandbox",
    clusterArn: "arn:cluster",
    serviceName: `sandbox-marketplace-api-${role}`,
    serviceArn: `arn:service:${role}`,
    role,
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    deploymentInProgress: false,
  };
}

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

    it("returns 500 on service error", async () => {
      vi.mocked(loadSecret).mockRejectedValue(new Error("secret not found"));
      const res = await request(app).get("/api/secret?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("secret not found");
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

    it("returns 500 on save error", async () => {
      vi.mocked(saveSecret).mockRejectedValue(new Error("access denied"));
      const res = await request(app).put("/api/secret").send({
        envId: "123-Admin",
        sessionId: "sess-1",
        value: {},
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("access denied");
    });
  });

  describe("GET /api/secret/versions", () => {
    it("returns 400 without params", async () => {
      const res = await request(app).get("/api/secret/versions");
      expect(res.status).toBe(400);
    });

    it("returns versions", async () => {
      vi.mocked(listVersions).mockResolvedValue([
        { versionId: "v1", versionStages: ["AWSCURRENT"] },
      ]);

      const res = await request(app).get("/api/secret/versions?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(200);
      expect(res.body.versions).toHaveLength(1);
    });

    it("returns 500 on error", async () => {
      vi.mocked(listVersions).mockRejectedValue(new Error("fail"));
      const res = await request(app).get("/api/secret/versions?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/secret/version/:versionId", () => {
    it("returns 400 without params", async () => {
      const res = await request(app).get("/api/secret/version/v1");
      expect(res.status).toBe(400);
    });

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

    it("returns 500 on error", async () => {
      vi.mocked(loadVersion).mockRejectedValue(new Error("version not found"));
      const res = await request(app).get("/api/secret/version/v1?envId=123-Admin&sessionId=sess-1");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("version not found");
    });
  });

  describe("GET /api/ecs/services", () => {
    it("returns 400 without params", async () => {
      const res = await request(app).get("/api/ecs/services");
      expect(res.status).toBe(400);
    });

    it("returns the marketplace api services", async () => {
      vi.mocked(discoverMarketplaceApiServices).mockResolvedValue({
        matches: [
          svc("web"),
          svc("worker"),
          svc("cron"),
        ],
        inspected: [
          {
            cluster: "marketplace-sandbox",
            serviceName: "sandbox-marketplace-api-web",
          },
        ],
      });

      const res = await request(app).get(
        "/api/ecs/services?envId=123-Admin&sessionId=sess-1"
      );
      expect(res.status).toBe(200);
      expect(res.body.environment).toBe("sandbox");
      expect(res.body.services).toHaveLength(3);
      expect(res.body.services.map((s: any) => s.role)).toEqual([
        "web",
        "worker",
        "cron",
      ]);
      expect(res.body.inspected).toBeUndefined();
    });

    it("exposes the inspected list when nothing matched", async () => {
      vi.mocked(discoverMarketplaceApiServices).mockResolvedValue({
        matches: [],
        inspected: [{ cluster: "c", serviceName: "sandbox-billing-api" }],
      });

      const res = await request(app).get(
        "/api/ecs/services?envId=123-Admin&sessionId=sess-1"
      );
      expect(res.status).toBe(200);
      expect(res.body.services).toHaveLength(0);
      expect(res.body.inspected).toHaveLength(1);
    });

    it("returns 500 on error", async () => {
      vi.mocked(discoverMarketplaceApiServices).mockRejectedValue(
        new Error("ecs:ListClusters denied")
      );
      const res = await request(app).get(
        "/api/ecs/services?envId=123-Admin&sessionId=sess-1"
      );
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("ecs:ListClusters denied");
    });
  });

  describe("GET /api/ecs/deployments", () => {
    it("returns 400 without params", async () => {
      const res = await request(app).get(
        "/api/ecs/deployments?envId=123-Admin&sessionId=sess-1"
      );
      expect(res.status).toBe(400);
    });

    it("parses the services list and returns the rollout status", async () => {
      vi.mocked(getDeploymentStatus).mockResolvedValue({
        services: [
          { ...svc("web"), stable: true },
          { ...svc("worker"), stable: true },
        ],
        allStable: true,
        anyFailed: false,
      });

      const res = await request(app).get(
        "/api/ecs/deployments?envId=123-Admin&sessionId=sess-1&services=" +
          encodeURIComponent(
            "marketplace-sandbox/sandbox-marketplace-api-web," +
              "marketplace-sandbox/sandbox-marketplace-api-worker"
          )
      );
      expect(res.status).toBe(200);
      expect(res.body.allStable).toBe(true);
      expect(vi.mocked(getDeploymentStatus).mock.calls[0][2]).toEqual([
        {
          cluster: "marketplace-sandbox",
          serviceName: "sandbox-marketplace-api-web",
        },
        {
          cluster: "marketplace-sandbox",
          serviceName: "sandbox-marketplace-api-worker",
        },
      ]);
    });

    it("returns 500 on a malformed services list", async () => {
      const res = await request(app).get(
        "/api/ecs/deployments?envId=123-Admin&sessionId=sess-1&services=nocluster"
      );
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("Invalid service reference");
    });

    it("returns 500 on error", async () => {
      vi.mocked(getDeploymentStatus).mockRejectedValue(
        new Error("service not found")
      );
      const res = await request(app).get(
        "/api/ecs/deployments?envId=123-Admin&sessionId=sess-1" +
          "&services=c%2Fsandbox-marketplace-api-web"
      );
      expect(res.status).toBe(500);
    });
  });

  // NOTE: /api/ecs/restart is rate limited to 3 requests / 5 min, so this
  // block must not issue more than 3 POSTs in total.
  describe("POST /api/ecs/restart", () => {
    it("returns 400 with an empty services array", async () => {
      const res = await request(app).post("/api/ecs/restart").send({
        envId: "123-Admin",
        sessionId: "sess-1",
        confirmation: "sandbox",
        services: [],
      });
      expect(res.status).toBe(400);
      expect(restartMarketplaceApi).not.toHaveBeenCalled();
    });

    it("triggers the restart on every submitted service", async () => {
      vi.mocked(restartMarketplaceApi).mockResolvedValue({
        environment: "sandbox",
        restarted: [
          {
            cluster: "marketplace-sandbox",
            serviceName: "sandbox-marketplace-api-web",
            role: "web",
            deploymentId: "ecs-svc/1",
          },
          {
            cluster: "marketplace-sandbox",
            serviceName: "sandbox-marketplace-api-worker",
            role: "worker",
            deploymentId: "ecs-svc/2",
          },
        ],
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      const services = [
        {
          cluster: "marketplace-sandbox",
          serviceName: "sandbox-marketplace-api-web",
        },
        {
          cluster: "marketplace-sandbox",
          serviceName: "sandbox-marketplace-api-worker",
        },
      ];

      const res = await request(app).post("/api/ecs/restart").send({
        envId: "123-Admin",
        sessionId: "sess-1",
        services,
        confirmation: "sandbox",
      });

      expect(res.status).toBe(200);
      expect(res.body.restarted).toHaveLength(2);
      expect(res.body.message).toContain("2 service(s)");
      expect(vi.mocked(restartMarketplaceApi).mock.calls[0][2]).toMatchObject({
        targets: services,
        confirmation: "sandbox",
      });
    });

    it("returns 500 when the service layer refuses", async () => {
      vi.mocked(restartMarketplaceApi).mockRejectedValue(
        new Error("Restarting a production service requires an acknowledgement")
      );

      const res = await request(app).post("/api/ecs/restart").send({
        envId: "123-Admin",
        sessionId: "sess-1",
        services: [
          {
            cluster: "marketplace-prod",
            serviceName: "prod-marketplace-api-web",
          },
        ],
        confirmation: "production",
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain("acknowledgement");
    });
  });

  describe("error handling", () => {
    it("GET /api/sso-profiles returns 500 on error", async () => {
      const { loadSsoProfiles } = await import("../../src/aws/ssoProfiles");
      vi.mocked(loadSsoProfiles).mockImplementationOnce(() => { throw new Error("fs error"); });
      const res = await request(app).get("/api/sso-profiles");
      expect(res.status).toBe(500);
    });

    it("POST /api/sso/login/start returns 500 on error", async () => {
      vi.mocked(startLogin).mockRejectedValueOnce(new Error("oidc error"));
      const res = await request(app)
        .post("/api/sso/login/start")
        .send({ profileName: "test" });
      expect(res.status).toBe(500);
    });

    it("POST /api/sso/login/poll returns 500 on error", async () => {
      vi.mocked(pollForLogin).mockRejectedValueOnce(new Error("poll error"));
      const res = await request(app)
        .post("/api/sso/login/poll")
        .send({ profileName: "test", deviceCode: "code", sessionId: "sess" });
      expect(res.status).toBe(500);
    });

    it("GET /api/sso/environments returns 500 on error", async () => {
      vi.mocked(getSsoSession).mockReturnValueOnce({
        ssoSession: "test",
        ssoRegion: "eu-west-1",
        accessToken: "token",
      });
      vi.mocked(discoverSsoEnvironments).mockRejectedValueOnce(new Error("discovery error"));
      const res = await request(app).get("/api/sso/environments?sessionId=sess-1");
      expect(res.status).toBe(500);
    });
  });
});
