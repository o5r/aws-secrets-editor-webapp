import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEcsSend = vi.fn();
const mockSsoSend = vi.fn();

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: class {
    send = mockEcsSend;
  },
  ListClustersCommand: class {
    constructor(public input: any) {}
  },
  ListServicesCommand: class {
    constructor(public input: any) {}
  },
  DescribeServicesCommand: class {
    constructor(public input: any) {}
  },
  UpdateServiceCommand: class {
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

import {
  isMarketplaceApiService,
  serviceRole,
  discoverMarketplaceApiServices,
  restartMarketplaceApi,
  getDeploymentStatus,
} from "../../src/aws/ecsService";
import { getSsoSession } from "../../src/aws/sessionStore";
import { getEnvironment } from "../../src/aws/envConfig";

const CLUSTER_ARN =
  "arn:aws:ecs:eu-west-1:123456789012:cluster/marketplace-sandbox";
const API_ARN =
  "arn:aws:ecs:eu-west-1:123456789012:service/marketplace-sandbox/sandbox-marketplace-api-web";
const WORKER_ARN =
  "arn:aws:ecs:eu-west-1:123456789012:service/marketplace-sandbox/sandbox-marketplace-api-worker";
const CRON_ARN =
  "arn:aws:ecs:eu-west-1:123456789012:service/marketplace-sandbox/sandbox-marketplace-api-cron";
const OTHER_ARN =
  "arn:aws:ecs:eu-west-1:123456789012:service/marketplace-sandbox/sandbox-billing-api";

function apiService(overrides: Record<string, any> = {}) {
  return {
    serviceName: "sandbox-marketplace-api-web",
    serviceArn: API_ARN,
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    taskDefinition:
      "arn:aws:ecs:eu-west-1:123456789012:task-definition/marketplace-api-web:42",
    deployments: [
      {
        id: "ecs-svc/123",
        status: "PRIMARY",
        rolloutState: "COMPLETED",
        runningCount: 2,
        desiredCount: 2,
        failedTasks: 0,
      },
    ],
    ...overrides,
  };
}

function workerService(overrides: Record<string, any> = {}) {
  return apiService({
    serviceName: "sandbox-marketplace-api-worker",
    serviceArn: WORKER_ARN,
    taskDefinition:
      "arn:aws:ecs:eu-west-1:123456789012:task-definition/marketplace-api-worker:42",
    deployments: [
      { id: "ecs-svc/worker", status: "PRIMARY", rolloutState: "COMPLETED" },
    ],
    ...overrides,
  });
}

function cronService(overrides: Record<string, any> = {}) {
  return apiService({
    serviceName: "sandbox-marketplace-api-cron",
    serviceArn: CRON_ARN,
    desiredCount: 1,
    runningCount: 1,
    taskDefinition:
      "arn:aws:ecs:eu-west-1:123456789012:task-definition/marketplace-api-cron:42",
    deployments: [
      { id: "ecs-svc/cron", status: "PRIMARY", rolloutState: "COMPLETED" },
    ],
    ...overrides,
  });
}

/** The three services as ECS would describe them (deliberately unordered). */
function allThree() {
  return [cronService(), apiService(), workerService()];
}

function useProduction() {
  vi.mocked(getEnvironment).mockReturnValue({
    id: "999-Admin",
    label: "production (Admin)",
    accountName: "production",
    regions: ["eu-west-1"],
    ssoAccountId: "999999999999",
    ssoRoleName: "Admin",
  });
}

/** Wire up the default happy-path AWS responses. */
function mockDiscovery(services: any[]) {

  mockSsoSend.mockResolvedValue({
    roleCredentials: {
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    },
  });

  mockEcsSend.mockImplementation((cmd: any) => {
    const name = cmd.constructor.name;
    if (name === "ListClustersCommand") {
      return Promise.resolve({ clusterArns: [CLUSTER_ARN] });
    }
    if (name === "ListServicesCommand") {
      return Promise.resolve({
        serviceArns: [API_ARN, WORKER_ARN, CRON_ARN, OTHER_ARN],
      });
    }
    if (name === "DescribeServicesCommand") {
      return Promise.resolve({ services });
    }
    if (name === "UpdateServiceCommand") {
      return Promise.resolve({ service: apiService() });
    }
    return Promise.resolve({});
  });
}

describe("ecsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MARKETPLACE_API_SERVICE_TOKENS;
    vi.mocked(getSsoSession).mockReturnValue({
      ssoSession: "test",
      ssoRegion: "eu-west-1",
      accessToken: "token",
    });
    vi.mocked(getEnvironment).mockReturnValue({
      id: "123-Admin",
      label: "sandbox (Admin)",
      accountName: "sandbox",
      regions: ["eu-west-1"],
      ssoAccountId: "123456789012",
      ssoRoleName: "Admin",
    });
  });

  describe("isMarketplaceApiService", () => {
    it("matches all three marketplace api components", () => {
      expect(isMarketplaceApiService("sandbox-marketplace-api-web")).toBe(true);
      expect(isMarketplaceApiService("sandbox-marketplace-api-worker")).toBe(
        true
      );
      expect(isMarketplaceApiService("sandbox-marketplace-api-cron")).toBe(true);
      expect(isMarketplaceApiService("prod-Marketplace-API-web")).toBe(true);
    });

    it("rejects services missing a required token", () => {
      expect(isMarketplaceApiService("marketplace-front")).toBe(false);
      expect(isMarketplaceApiService("sandbox-billing-api")).toBe(false);
    });

    it("honours token overrides from the environment", () => {
      process.env.MARKETPLACE_API_SERVICE_TOKENS = "shop,backend";
      expect(isMarketplaceApiService("shop-backend")).toBe(true);
      expect(isMarketplaceApiService("marketplace-api-web")).toBe(false);
    });
  });

  describe("serviceRole", () => {
    it("derives the component role from the name", () => {
      expect(serviceRole("sandbox-marketplace-api-web")).toBe("web");
      expect(serviceRole("sandbox-marketplace-api-worker")).toBe("worker");
      expect(serviceRole("sandbox-marketplace-api-cron")).toBe("cron");
      expect(serviceRole("sandbox-marketplace-api")).toBe("other");
    });

    it("does not match a role embedded in a longer word", () => {
      expect(serviceRole("marketplace-api-webhook")).toBe("other");
    });
  });

  describe("discoverMarketplaceApiServices", () => {
    it("returns web, worker and cron, ordered, ignoring unrelated services", async () => {
      mockDiscovery(allThree());

      const { matches, inspected } = await discoverMarketplaceApiServices(
        "123-Admin",
        "sess-1"
      );

      expect(matches.map((m) => m.role)).toEqual(["web", "worker", "cron"]);
      expect(matches[0].serviceName).toBe("sandbox-marketplace-api-web");
      expect(matches[0].cluster).toBe("marketplace-sandbox");
      expect(matches[0].taskDefinition).toBe("marketplace-api-web:42");
      expect(matches[0].deploymentInProgress).toBe(false);

      // billing-api was listed but never described
      expect(inspected).toHaveLength(4);
      expect(matches.some((m) => m.serviceName.includes("billing"))).toBe(false);
    });

    it("flags an in-flight rollout", async () => {
      mockDiscovery([
        apiService({
          deployments: [
            { id: "d1", status: "PRIMARY", rolloutState: "IN_PROGRESS" },
          ],
        }),
      ]);

      const { matches } = await discoverMarketplaceApiServices(
        "123-Admin",
        "sess-1"
      );
      expect(matches[0].deploymentInProgress).toBe(true);
    });

    it("throws without an active SSO session", async () => {
      vi.mocked(getSsoSession).mockReturnValue(undefined);
      await expect(
        discoverMarketplaceApiServices("123-Admin", "sess-1")
      ).rejects.toThrow(/No active SSO session/);
    });

    it("throws when role credentials cannot be obtained", async () => {
      mockDiscovery([apiService()]);
      mockSsoSend.mockResolvedValue({ roleCredentials: {} });
      await expect(
        discoverMarketplaceApiServices("123-Admin", "sess-1")
      ).rejects.toThrow(/role credentials/);
    });
  });

  describe("restartMarketplaceApi", () => {
    const allTargets = [
      { cluster: "marketplace-sandbox", serviceName: "sandbox-marketplace-api-web" },
      { cluster: "marketplace-sandbox", serviceName: "sandbox-marketplace-api-worker" },
      { cluster: "marketplace-sandbox", serviceName: "sandbox-marketplace-api-cron" },
    ];
    const baseReq = { targets: allTargets, confirmation: "sandbox" };

    function updateCalls() {
      return mockEcsSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c.constructor.name === "UpdateServiceCommand");
    }

    it("forces a new deployment on every selected service", async () => {
      mockDiscovery(allThree());

      const result = await restartMarketplaceApi("123-Admin", "sess-1", baseReq);

      expect(result.environment).toBe("sandbox");
      expect(result.restarted.map((r) => r.role)).toEqual([
        "web",
        "worker",
        "cron",
      ]);

      const calls = updateCalls();
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.input.service)).toEqual([
        API_ARN,
        WORKER_ARN,
        CRON_ARN,
      ]);
      for (const c of calls) {
        expect(c.input.forceNewDeployment).toBe(true);
        expect(c.input.cluster).toBe(CLUSTER_ARN);
      }
    });

    it("restarts only the selected subset", async () => {
      mockDiscovery(allThree());

      const result = await restartMarketplaceApi("123-Admin", "sess-1", {
        ...baseReq,
        targets: [allTargets[1]],
      });

      expect(result.restarted).toHaveLength(1);
      expect(result.restarted[0].role).toBe("worker");
      expect(updateCalls()).toHaveLength(1);
    });

    it("requires at least one target", async () => {
      mockDiscovery(allThree());
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", { ...baseReq, targets: [] })
      ).rejects.toThrow(/At least one service/);
    });

    it("rejects a confirmation mismatch", async () => {
      mockDiscovery(allThree());
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", {
          ...baseReq,
          confirmation: "staging",
        })
      ).rejects.toThrow(/Confirmation mismatch/);
    });

    it("rejects production without an explicit acknowledgement", async () => {
      useProduction();
      mockDiscovery(allThree());

      await expect(
        restartMarketplaceApi("999-Admin", "sess-1", {
          ...baseReq,
          confirmation: "production",
        })
      ).rejects.toThrow(/acknowledgement/);
      expect(updateCalls()).toHaveLength(0);
    });

    it("allows production with an explicit acknowledgement", async () => {
      useProduction();
      mockDiscovery(allThree());

      const result = await restartMarketplaceApi("999-Admin", "sess-1", {
        ...baseReq,
        confirmation: "production",
        acknowledgeProduction: true,
      });
      expect(result.environment).toBe("production");
      expect(result.restarted).toHaveLength(3);
    });

    it("refuses to restart a non-marketplace-api service", async () => {
      mockDiscovery(allThree());
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", {
          ...baseReq,
          targets: [
            { cluster: "marketplace-sandbox", serviceName: "sandbox-billing-api" },
          ],
        })
      ).rejects.toThrow(/not a marketplace API service/);
      expect(updateCalls()).toHaveLength(0);
    });

    it("refuses when a target is not found in the environment", async () => {
      mockDiscovery(allThree());
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", {
          ...baseReq,
          targets: [
            {
              cluster: "some-other-cluster",
              serviceName: "sandbox-marketplace-api-web",
            },
          ],
        })
      ).rejects.toThrow(/was not found in cluster/);
    });

    it("refuses when a service is scaled to zero", async () => {
      mockDiscovery([apiService({ desiredCount: 0, runningCount: 0 })]);
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", {
          ...baseReq,
          targets: [allTargets[0]],
        })
      ).rejects.toThrow(/desired count of 0/);
    });

    it("refuses when a deployment is already in progress", async () => {
      mockDiscovery([
        apiService({
          deployments: [
            { id: "d1", status: "PRIMARY", rolloutState: "IN_PROGRESS" },
          ],
        }),
      ]);
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", {
          ...baseReq,
          targets: [allTargets[0]],
        })
      ).rejects.toThrow(/already in progress/);
    });

    it("validates every target before restarting any of them", async () => {
      // web is fine, worker is scaled to 0 — nothing must be restarted
      mockDiscovery([
        apiService(),
        workerService({ desiredCount: 0, runningCount: 0 }),
        cronService(),
      ]);

      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", baseReq)
      ).rejects.toThrow(/desired count of 0/);
      expect(updateCalls()).toHaveLength(0);
    });

    it("allows overriding an in-flight deployment with force", async () => {
      mockDiscovery([
        apiService({
          deployments: [
            { id: "d1", status: "PRIMARY", rolloutState: "IN_PROGRESS" },
          ],
        }),
      ]);
      const result = await restartMarketplaceApi("123-Admin", "sess-1", {
        ...baseReq,
        targets: [allTargets[0]],
        force: true,
      });
      expect(result.restarted).toHaveLength(1);
    });

    it("requires a cluster and a serviceName on each target", async () => {
      mockDiscovery(allThree());
      await expect(
        restartMarketplaceApi("123-Admin", "sess-1", {
          ...baseReq,
          targets: [{ cluster: "", serviceName: "sandbox-marketplace-api-web" }],
        })
      ).rejects.toThrow(/cluster and a serviceName/);
    });
  });

  describe("getDeploymentStatus", () => {
    const allTargets = [
      { cluster: "marketplace-sandbox", serviceName: "sandbox-marketplace-api-web" },
      { cluster: "marketplace-sandbox", serviceName: "sandbox-marketplace-api-worker" },
      { cluster: "marketplace-sandbox", serviceName: "sandbox-marketplace-api-cron" },
    ];

    it("reports all services stable", async () => {
      mockDiscovery(allThree());
      const report = await getDeploymentStatus("123-Admin", "sess-1", allTargets);
      expect(report.services).toHaveLength(3);
      expect(report.allStable).toBe(true);
      expect(report.anyFailed).toBe(false);
    });

    it("is not stable while one service is still rolling out", async () => {
      mockDiscovery([
        apiService(),
        workerService({
          runningCount: 1,
          deployments: [
            { id: "d1", status: "PRIMARY", rolloutState: "IN_PROGRESS" },
          ],
        }),
        cronService(),
      ]);
      const report = await getDeploymentStatus("123-Admin", "sess-1", allTargets);
      expect(report.allStable).toBe(false);
      expect(report.anyFailed).toBe(false);
      expect(report.services.find((s) => s.role === "worker")?.stable).toBe(
        false
      );
    });

    it("reports a failed rollout", async () => {
      mockDiscovery([
        apiService(),
        workerService({
          deployments: [
            {
              id: "d1",
              status: "PRIMARY",
              rolloutState: "FAILED",
              rolloutStateReason: "circuit breaker tripped",
            },
          ],
        }),
        cronService(),
      ]);
      const report = await getDeploymentStatus("123-Admin", "sess-1", allTargets);
      expect(report.anyFailed).toBe(true);
      expect(report.allStable).toBe(false);
    });

    it("requires at least one target", async () => {
      await expect(
        getDeploymentStatus("123-Admin", "sess-1", [])
      ).rejects.toThrow(/At least one service/);
    });

    it("rejects a non-marketplace-api service", async () => {
      await expect(
        getDeploymentStatus("123-Admin", "sess-1", [
          { cluster: "c", serviceName: "sandbox-billing-api" },
        ])
      ).rejects.toThrow(/not a marketplace API service/);
    });

    it("throws when a service is unknown", async () => {
      mockDiscovery(allThree());
      await expect(
        getDeploymentStatus("123-Admin", "sess-1", [
          {
            cluster: "unknown-cluster",
            serviceName: "sandbox-marketplace-api-web",
          },
        ])
      ).rejects.toThrow(/was not found/);
    });
  });
});
