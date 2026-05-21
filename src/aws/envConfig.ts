import type { EnvironmentConfig } from "./credentials";

// Dynamic environments discovered via SSO, keyed by session id.
const dynamicEnvs = new Map<string, EnvironmentConfig[]>();

export function registerDynamicEnvironments(
  sessionId: string,
  envs: EnvironmentConfig[]
): void {
  dynamicEnvs.set(sessionId, envs);
}

export function getDynamicEnvironments(
  sessionId: string
): EnvironmentConfig[] {
  return dynamicEnvs.get(sessionId) ?? [];
}

export function getEnvironment(
  envId: string,
  sessionId: string
): EnvironmentConfig {
  const dynEnvs = getDynamicEnvironments(sessionId);
  const dynEnv = dynEnvs.find((e) => e.id === envId);
  if (dynEnv) return dynEnv;

  throw new Error(`Unknown environment id: ${envId}`);
}
