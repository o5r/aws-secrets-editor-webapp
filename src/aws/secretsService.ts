import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ListSecretVersionIdsCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSOClient,
  GetRoleCredentialsCommand,
} from "@aws-sdk/client-sso";
import { getSsoSession } from "./sessionStore";
import { getEnvironment } from "./envConfig";

const REGION = "eu-west-1";
const SECRET_KEY = "ALL_ORGANIZATIONS_SETTINGS";

function buildSecretName(accountName: string): string {
  return `${accountName}/marketplace/elasticbeanstalk/secrets`;
}

async function createSecretsManagerClient(
  envId: string,
  sessionId: string
): Promise<SecretsManagerClient> {
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

  return new SecretsManagerClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken ?? undefined,
    },
  });
}

/**
 * Parse the full secret string. The secret is a JSON object where each key
 * maps to a string value. ALL_ORGANIZATION_SETTINGS specifically contains
 * a JSON-encoded string.
 */
function parseFullSecret(secretString: string): Record<string, string> {
  return JSON.parse(secretString);
}

export interface LoadSecretResult {
  value: unknown;
  versionId?: string;
  versionStages?: string[];
}

export async function loadSecret(
  envId: string,
  sessionId: string
): Promise<LoadSecretResult> {
  const client = await createSecretsManagerClient(envId, sessionId);
  const env = getEnvironment(envId, sessionId);
  const secretName = buildSecretName(env.accountName);

  const res = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  if (!res.SecretString) {
    throw new Error("Secret has no string value");
  }

  const fullSecret = parseFullSecret(res.SecretString);

  // Log available keys for debugging
  // eslint-disable-next-line no-console
  console.log(`Secret "${secretName}" keys:`, Object.keys(fullSecret));

  const rawValue = fullSecret[SECRET_KEY];

  if (rawValue === undefined) {
    throw new Error(
      `Key "${SECRET_KEY}" not found in secret "${secretName}". Available keys: ${Object.keys(fullSecret).join(", ")}`
    );
  }

  // The value is itself a JSON string
  const value = JSON.parse(rawValue);

  return {
    value,
    versionId: res.VersionId,
    versionStages: res.VersionStages,
  };
}

export interface SaveSecretResult {
  versionId?: string;
}

export async function saveSecret(
  envId: string,
  sessionId: string,
  newValue: unknown
): Promise<SaveSecretResult> {
  const client = await createSecretsManagerClient(envId, sessionId);
  const env = getEnvironment(envId, sessionId);
  const secretName = buildSecretName(env.accountName);

  // Read current full secret to preserve other keys
  const currentRes = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  if (!currentRes.SecretString) {
    throw new Error("Secret has no string value");
  }

  const fullSecret = parseFullSecret(currentRes.SecretString);

  // Replace only ALL_ORGANIZATION_SETTINGS, keep everything else
  fullSecret[SECRET_KEY] = JSON.stringify(newValue);

  const res = await client.send(
    new PutSecretValueCommand({
      SecretId: secretName,
      SecretString: JSON.stringify(fullSecret),
    })
  );

  return {
    versionId: res.VersionId,
  };
}

export interface SecretVersionInfo {
  versionId: string;
  createdDate?: Date;
  versionStages: string[];
}

export async function listVersions(
  envId: string,
  sessionId: string
): Promise<SecretVersionInfo[]> {
  const client = await createSecretsManagerClient(envId, sessionId);
  const env = getEnvironment(envId, sessionId);
  const secretName = buildSecretName(env.accountName);

  const res = await client.send(
    new ListSecretVersionIdsCommand({
      SecretId: secretName,
      IncludeDeprecated: false,
    })
  );

  return (res.Versions ?? [])
    .filter((v) => v.VersionId)
    .map((v) => ({
      versionId: v.VersionId!,
      createdDate: v.CreatedDate,
      versionStages: v.VersionStages ?? [],
    }))
    .sort((a, b) => {
      const da = a.createdDate?.getTime() ?? 0;
      const db = b.createdDate?.getTime() ?? 0;
      return db - da;
    });
}

export async function loadVersion(
  envId: string,
  sessionId: string,
  versionId: string
): Promise<LoadSecretResult> {
  const client = await createSecretsManagerClient(envId, sessionId);
  const env = getEnvironment(envId, sessionId);
  const secretName = buildSecretName(env.accountName);

  const res = await client.send(
    new GetSecretValueCommand({
      SecretId: secretName,
      VersionId: versionId,
    })
  );

  if (!res.SecretString) {
    throw new Error("Secret version has no string value");
  }

  const fullSecret = parseFullSecret(res.SecretString);
  const rawValue = fullSecret[SECRET_KEY];

  if (rawValue === undefined) {
    throw new Error(
      `Key "${SECRET_KEY}" not found in version "${versionId}"`
    );
  }

  const value = JSON.parse(rawValue);

  return {
    value,
    versionId: res.VersionId,
    versionStages: res.VersionStages,
  };
}
