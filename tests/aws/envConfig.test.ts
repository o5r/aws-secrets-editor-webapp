import { describe, it, expect, beforeEach } from "vitest";
import {
  registerDynamicEnvironments,
  getDynamicEnvironments,
  getEnvironment,
} from "../../src/aws/envConfig";

describe("envConfig", () => {
  const testEnv = {
    id: "123-Admin",
    label: "sandbox (Admin)",
    accountName: "sandbox",
    regions: ["eu-west-1"],
    ssoAccountId: "123456789012",
    ssoRoleName: "Admin",
  };

  beforeEach(() => {
    // Register fresh environments for each test
    registerDynamicEnvironments("test-session", [testEnv]);
  });

  describe("registerDynamicEnvironments", () => {
    it("stores environments for a session", () => {
      const envs = getDynamicEnvironments("test-session");
      expect(envs).toHaveLength(1);
      expect(envs[0].id).toBe("123-Admin");
    });

    it("overwrites existing environments for the same session", () => {
      const newEnv = { ...testEnv, id: "456-Viewer" };
      registerDynamicEnvironments("test-session", [newEnv]);
      const envs = getDynamicEnvironments("test-session");
      expect(envs).toHaveLength(1);
      expect(envs[0].id).toBe("456-Viewer");
    });
  });

  describe("getDynamicEnvironments", () => {
    it("returns empty array for unknown session", () => {
      const envs = getDynamicEnvironments("unknown-session");
      expect(envs).toEqual([]);
    });
  });

  describe("getEnvironment", () => {
    it("returns matching environment", () => {
      const env = getEnvironment("123-Admin", "test-session");
      expect(env.label).toBe("sandbox (Admin)");
    });

    it("throws for unknown environment id", () => {
      expect(() => getEnvironment("unknown-id", "test-session")).toThrow(
        "Unknown environment id: unknown-id"
      );
    });

    it("throws for unknown session", () => {
      expect(() => getEnvironment("123-Admin", "no-session")).toThrow(
        "Unknown environment id: 123-Admin"
      );
    });
  });
});
