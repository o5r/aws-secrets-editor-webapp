import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSsoSend = vi.fn();

vi.mock("@aws-sdk/client-sso", () => ({
  SSOClient: class {
    send = mockSsoSend;
  },
  ListAccountsCommand: class {
    constructor(public input: any) {}
  },
  ListAccountRolesCommand: class {
    constructor(public input: any) {}
  },
}));

import { discoverSsoEnvironments } from "../../src/aws/ssoDiscovery";
import type { ConnectedSsoSession } from "../../src/aws/sessionStore";

const session: ConnectedSsoSession = {
  ssoSession: "test",
  ssoRegion: "eu-west-1",
  accessToken: "token",
};

describe("ssoDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only sandbox/staging/production environments", async () => {
    // ListAccounts
    mockSsoSend.mockResolvedValueOnce({
      accountList: [
        { accountId: "111", accountName: "Digital Lending Sandbox" },
        { accountId: "222", accountName: "Digital Lending Staging" },
        { accountId: "333", accountName: "Digital Lending Production" },
        { accountId: "444", accountName: "Development" },
      ],
      nextToken: undefined,
    });
    // ListAccountRoles for each matched account (3 calls)
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "ReadOnly" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(session);

    expect(envs).toHaveLength(3);
    expect(envs[0].accountName).toBe("sandbox");
    expect(envs[0].label).toBe("Digital Lending Sandbox (Admin)");
    expect(envs[1].accountName).toBe("staging");
    expect(envs[2].accountName).toBe("production");
  });

  it("skips accounts without accountId", async () => {
    mockSsoSend.mockResolvedValueOnce({
      accountList: [{ accountName: "Sandbox" }], // no accountId
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(session);
    expect(envs).toEqual([]);
  });

  it("skips roles without roleName", async () => {
    mockSsoSend.mockResolvedValueOnce({
      accountList: [{ accountId: "111", accountName: "Sandbox" }],
      nextToken: undefined,
    });
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: undefined }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(session);
    expect(envs).toEqual([]);
  });

  it("uses accountId as fallback when accountName is missing", async () => {
    mockSsoSend.mockResolvedValueOnce({
      accountList: [{ accountId: "sandbox111" }], // no accountName, but accountId contains "sandbox"
      nextToken: undefined,
    });
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(session);
    expect(envs).toHaveLength(1);
    expect(envs[0].accountName).toBe("sandbox");
  });

  it("paginates through accounts and roles", async () => {
    // First page of accounts
    mockSsoSend.mockResolvedValueOnce({
      accountList: [{ accountId: "111", accountName: "Sandbox" }],
      nextToken: "next-page",
    });
    // Second page of accounts
    mockSsoSend.mockResolvedValueOnce({
      accountList: [{ accountId: "222", accountName: "Production" }],
      nextToken: undefined,
    });
    // Roles for Sandbox - first page
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: "role-next",
    });
    // Roles for Sandbox - second page
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "ReadOnly" }],
      nextToken: undefined,
    });
    // Roles for Production
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(session);
    expect(envs).toHaveLength(3);
    expect(envs[0].id).toBe("111-Admin");
    expect(envs[1].id).toBe("111-ReadOnly");
    expect(envs[2].id).toBe("222-Admin");
  });

  it("sets regions to eu-west-1", async () => {
    mockSsoSend.mockResolvedValueOnce({
      accountList: [{ accountId: "111", accountName: "Sandbox" }],
      nextToken: undefined,
    });
    mockSsoSend.mockResolvedValueOnce({
      roleList: [{ roleName: "Admin" }],
      nextToken: undefined,
    });

    const envs = await discoverSsoEnvironments(session);
    expect(envs[0].regions).toEqual(["eu-west-1"]);
  });
});
