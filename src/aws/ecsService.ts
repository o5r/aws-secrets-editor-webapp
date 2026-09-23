import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  UpdateServiceCommand,
  type Service,
} from "@aws-sdk/client-ecs";
import { SSOClient, GetRoleCredentialsCommand } from "@aws-sdk/client-sso";
import { getSsoSession } from "./sessionStore";
import { getEnvironment } from "./envConfig";

const REGION = "eu-west-1";

/** DescribeServices accepts at most 10 services per call. */
const DESCRIBE_BATCH_SIZE = 10;

/**
 * The marketplace API is deployed as three ECS services that each load the
 * secret at startup: `<env>-marketplace-api-web`, `-worker` and `-cron`.
 * All three must be replaced for a secret change to take effect everywhere.
 *
 * A service is considered part of the marketplace API when its name contains
 * every required token. The token list is overridable via an environment
 * variable so that a naming change on the infrastructure side does not
 * require a code change.
 */
function requiredTokens(): string[] {
  return parseTokens(process.env.MARKETPLACE_API_SERVICE_TOKENS, [
    "marketplace",
    "api",
  ]);
}

function parseTokens(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : fallback;
}

export function isMarketplaceApiService(serviceName: string): boolean {
  const name = serviceName.toLowerCase();
  return requiredTokens().every((t) => name.includes(t));
}

export type ServiceRole = "web" | "worker" | "cron" | "other";

/** Derive the component role from the service name suffix. */
export function serviceRole(serviceName: string): ServiceRole {
  const name = serviceName.toLowerCase();
  if (/(^|[-_])web([-_]|$)/.test(name)) return "web";
  if (/(^|[-_])worker([-_]|$)/.test(name)) return "worker";
  if (/(^|[-_])cron([-_]|$)/.test(name)) return "cron";
  return "other";
}

/** Stable display order: web first, then worker, then cron. */
const ROLE_ORDER: ServiceRole[] = ["web", "worker", "cron", "other"];

function compareServices(a: EcsServiceInfo, b: EcsServiceInfo): number {
  const byRole =
    ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
  return byRole !== 0 ? byRole : a.serviceName.localeCompare(b.serviceName);
}

/** Extract the resource name from an ARN (or return the value as-is). */
function nameFromArn(arn: string): string {
  const parts = arn.split("/");
  return parts[parts.length - 1] || arn;
}

async function createEcsClient(
  envId: string,
  sessionId: string
): Promise<ECSClient> {
  const session = getSsoSession(sessionId);
  if (!session) {
    throw new Error("No active SSO session. Please connect first.");
  }

  const env = getEnvironment(envId, sessionId);

  const sso = new SSOClient({ region: session.ssoRegion });
  const roleRes = await sso.send(
    new GetRoleCredentialsCommand({
      accessToken: session.accessToken,
      accountId: env.ssoAccountId,
      roleName: env.ssoRoleName,
    })
  );

  const creds = roleRes.roleCredentials;
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    throw new Error("Failed to obtain role credentials via SSO");
  }

  return new ECSClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken ?? undefined,
    },
  });
}

export interface DeploymentInfo {
  id?: string;
  status?: string;
  rolloutState?: string;
  rolloutStateReason?: string;
  runningCount?: number;
  desiredCount?: number;
  failedTasks?: number;
  updatedAt?: Date;
}

export interface EcsServiceInfo {
  cluster: string;
  clusterArn: string;
  serviceName: string;
  serviceArn: string;
  /** web | worker | cron, derived from the service name. */
  role: ServiceRole;
  status?: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  taskDefinition?: string;
  /** The PRIMARY deployment, i.e. the one currently rolling out or stable. */
  primaryDeployment?: DeploymentInfo;
  /** True when a rollout is currently in flight. */
  deploymentInProgress: boolean;
}

function toDeploymentInfo(service: Service): DeploymentInfo | undefined {
  const primary = (service.deployments ?? []).find(
    (d) => d.status === "PRIMARY"
  );
  if (!primary) return undefined;
  return {
    id: primary.id,
    status: primary.status,
    rolloutState: primary.rolloutState,
    rolloutStateReason: primary.rolloutStateReason,
    runningCount: primary.runningCount,
    desiredCount: primary.desiredCount,
    failedTasks: primary.failedTasks,
    updatedAt: primary.updatedAt,
  };
}

function toServiceInfo(service: Service, clusterArn: string): EcsServiceInfo {
  const primaryDeployment = toDeploymentInfo(service);
  const deployments = service.deployments ?? [];
  const serviceName =
    service.serviceName ?? nameFromArn(service.serviceArn ?? "");
  return {
    cluster: nameFromArn(clusterArn),
    clusterArn,
    serviceName,
    serviceArn: service.serviceArn ?? "",
    role: serviceRole(serviceName),
    status: service.status,
    desiredCount: service.desiredCount ?? 0,
    runningCount: service.runningCount ?? 0,
    pendingCount: service.pendingCount ?? 0,
    taskDefinition: service.taskDefinition
      ? nameFromArn(service.taskDefinition)
      : undefined,
    primaryDeployment,
    deploymentInProgress:
      primaryDeployment?.rolloutState === "IN_PROGRESS" || deployments.length > 1,
  };
}

async function listClusterArns(client: ECSClient): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListClustersCommand({ nextToken }));
    arns.push(...(res.clusterArns ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return arns;
}

async function listServiceArns(
  client: ECSClient,
  clusterArn: string
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListServicesCommand({ cluster: clusterArn, nextToken })
    );
    arns.push(...(res.serviceArns ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return arns;
}

async function describeServices(
  client: ECSClient,
  clusterArn: string,
  serviceArns: string[]
): Promise<EcsServiceInfo[]> {
  const result: EcsServiceInfo[] = [];
  for (let i = 0; i < serviceArns.length; i += DESCRIBE_BATCH_SIZE) {
    const batch = serviceArns.slice(i, i + DESCRIBE_BATCH_SIZE);
    const res = await client.send(
      new DescribeServicesCommand({ cluster: clusterArn, services: batch })
    );
    for (const service of res.services ?? []) {
      result.push(toServiceInfo(service, clusterArn));
    }
  }
  return result;
}

export interface DiscoverResult {
  /** Services identified as the marketplace API. */
  matches: EcsServiceInfo[];
  /** Every service name seen, to help diagnose an empty match set. */
  inspected: { cluster: string; serviceName: string }[];
}

/**
 * Discover the marketplace API service(s) across every ECS cluster reachable
 * with the environment's SSO role.
 */
export async function discoverMarketplaceApiServices(
  envId: string,
  sessionId: string
): Promise<DiscoverResult> {
  const client = await createEcsClient(envId, sessionId);

  const clusterArns = await listClusterArns(client);
  const matches: EcsServiceInfo[] = [];
  const inspected: { cluster: string; serviceName: string }[] = [];

  for (const clusterArn of clusterArns) {
    const serviceArns = await listServiceArns(client, clusterArn);
    const candidateArns: string[] = [];

    for (const serviceArn of serviceArns) {
      const serviceName = nameFromArn(serviceArn);
      inspected.push({ cluster: nameFromArn(clusterArn), serviceName });
      if (isMarketplaceApiService(serviceName)) {
        candidateArns.push(serviceArn);
      }
    }

    if (candidateArns.length > 0) {
      matches.push(...(await describeServices(client, clusterArn, candidateArns)));
    }
  }

  return { matches: matches.sort(compareServices), inspected };
}

export interface ServiceTarget {
  cluster: string;
  serviceName: string;
}

export interface RestartRequest {
  /** The services to restart (typically web + worker + cron). */
  targets: ServiceTarget[];
  /** Must equal the environment's account name (sandbox/staging/production). */
  confirmation: string;
  /** Required when targeting production. */
  acknowledgeProduction?: boolean;
  /** Allow restarting even if a rollout is already in flight. */
  force?: boolean;
}

export interface RestartedService {
  cluster: string;
  serviceName: string;
  role: ServiceRole;
  deploymentId?: string;
}

export interface RestartResult {
  environment: string;
  restarted: RestartedService[];
  startedAt: string;
}

/**
 * Force a new deployment of the selected marketplace API services so they pick
 * up the latest Secrets Manager value.
 *
 * Safety rules enforced here (the UI guards are only a first line of defence):
 *  1. Every target must resolve as a marketplace API service — this endpoint
 *     cannot be used to restart an arbitrary ECS service.
 *  2. `confirmation` must match the environment name exactly.
 *  3. Production additionally requires `acknowledgeProduction: true`.
 *  4. A service scaled to 0 is never restarted.
 *  5. A rollout already in progress blocks the restart unless `force` is set.
 *
 * All targets are validated *before* any UpdateService call, so a rejected
 * batch never leaves the services in a half-restarted state.
 */
export async function restartMarketplaceApi(
  envId: string,
  sessionId: string,
  req: RestartRequest
): Promise<RestartResult> {
  const env = getEnvironment(envId, sessionId);
  const environment = env.accountName;
  const targets = req.targets ?? [];

  if (targets.length === 0) {
    throw new Error("At least one service must be selected");
  }

  if (req.confirmation !== environment) {
    throw new Error(
      `Confirmation mismatch: expected "${environment}" to confirm the restart`
    );
  }

  if (environment === "production" && req.acknowledgeProduction !== true) {
    throw new Error(
      "Restarting a production service requires an explicit acknowledgement " +
        "(acknowledgeProduction: true)"
    );
  }

  for (const t of targets) {
    if (!t?.cluster || !t?.serviceName) {
      throw new Error("Each target requires a cluster and a serviceName");
    }
    if (!isMarketplaceApiService(t.serviceName)) {
      throw new Error(
        `Service "${t.serviceName}" is not a marketplace API service. ` +
          "Only the marketplace API can be restarted from this application."
      );
    }
  }

  // Re-resolve server-side: never trust the client-supplied targets.
  const { matches } = await discoverMarketplaceApiServices(envId, sessionId);

  const resolved: EcsServiceInfo[] = [];
  for (const t of targets) {
    const found = matches.find(
      (s) => s.serviceName === t.serviceName && s.cluster === t.cluster
    );
    if (!found) {
      throw new Error(
        `Service "${t.serviceName}" was not found in cluster "${t.cluster}" ` +
          `for environment "${environment}"`
      );
    }
    if (found.desiredCount === 0) {
      throw new Error(
        `Service "${found.serviceName}" has a desired count of 0 — ` +
          "nothing to restart. Scale it up first."
      );
    }
    if (found.deploymentInProgress && req.force !== true) {
      throw new Error(
        `A deployment is already in progress on "${found.serviceName}" ` +
          `(rollout state: ${found.primaryDeployment?.rolloutState ?? "unknown"}). ` +
          "Wait for it to finish before restarting again."
      );
    }
    resolved.push(found);
  }

  const client = await createEcsClient(envId, sessionId);
  const restarted: RestartedService[] = [];

  for (const target of resolved) {
    const res = await client.send(
      new UpdateServiceCommand({
        cluster: target.clusterArn,
        service: target.serviceArn,
        forceNewDeployment: true,
      })
    );
    restarted.push({
      cluster: target.cluster,
      serviceName: target.serviceName,
      role: target.role,
      deploymentId: res.service ? toDeploymentInfo(res.service)?.id : undefined,
    });
  }

  return {
    environment,
    restarted,
    startedAt: new Date().toISOString(),
  };
}

export interface DeploymentStatus extends EcsServiceInfo {
  /** Convenience flag for the UI polling loop. */
  stable: boolean;
}

export interface DeploymentStatusReport {
  services: DeploymentStatus[];
  /** True when every requested service finished rolling out successfully. */
  allStable: boolean;
  /** True when at least one rollout failed. */
  anyFailed: boolean;
}

/** Poll the rollout state of the given marketplace API services. */
export async function getDeploymentStatus(
  envId: string,
  sessionId: string,
  targets: ServiceTarget[]
): Promise<DeploymentStatusReport> {
  if (!targets || targets.length === 0) {
    throw new Error("At least one service must be requested");
  }

  for (const t of targets) {
    if (!isMarketplaceApiService(t.serviceName)) {
      throw new Error(
        `Service "${t.serviceName}" is not a marketplace API service`
      );
    }
  }

  const { matches } = await discoverMarketplaceApiServices(envId, sessionId);

  const services: DeploymentStatus[] = targets.map((t) => {
    const found = matches.find(
      (s) => s.serviceName === t.serviceName && s.cluster === t.cluster
    );
    if (!found) {
      throw new Error(
        `Service "${t.serviceName}" was not found in cluster "${t.cluster}"`
      );
    }
    const rolloutState = found.primaryDeployment?.rolloutState;
    return {
      ...found,
      stable:
        rolloutState === "COMPLETED" &&
        !found.deploymentInProgress &&
        found.runningCount === found.desiredCount,
    };
  });

  return {
    services,
    allStable: services.every((s) => s.stable),
    anyFailed: services.some(
      (s) => s.primaryDeployment?.rolloutState === "FAILED"
    ),
  };
}
