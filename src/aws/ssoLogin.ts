import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} from "@aws-sdk/client-sso-oidc";
import { loadSsoProfiles } from "./ssoProfiles";
import { setSsoSession } from "./sessionStore";

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

let registeredClient: RegisteredClient | null = null;

async function getRegisteredClient(region: string): Promise<RegisteredClient> {
  if (registeredClient) return registeredClient;

  const client = new SSOOIDCClient({ region });

  const res = await client.send(
    new RegisterClientCommand({
      clientName: "aws-secrets-editor-webapp",
      clientType: "public",
    })
  );

  if (!res.clientId || !res.clientSecret) {
    throw new Error("Failed to register SSO OIDC client");
  }

  registeredClient = {
    clientId: res.clientId,
    clientSecret: res.clientSecret,
  };
  return registeredClient;
}

export interface StartLoginResult {
  deviceCode: string;
  verificationUri: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: Date;
}

export async function startLogin(profileName: string): Promise<StartLoginResult> {
  const profile = loadSsoProfiles().find((p) => p.name === profileName);
  if (!profile) {
    throw new Error(`Unknown SSO profile: ${profileName}`);
  }

  const { clientId, clientSecret } = await getRegisteredClient(
    profile.ssoRegion
  );
  const client = new SSOOIDCClient({ region: profile.ssoRegion });

  const res = await client.send(
    new StartDeviceAuthorizationCommand({
      clientId,
      clientSecret,
      startUrl: profile.ssoStartUrl,
    })
  );

  if (
    !res.deviceCode ||
    !res.verificationUriComplete ||
    !res.userCode ||
    !res.interval ||
    !res.expiresIn
  ) {
    throw new Error("Incomplete device authorization response from SSO");
  }

  return {
    deviceCode: res.deviceCode,
    verificationUri: res.verificationUriComplete,
    userCode: res.userCode,
    intervalSeconds: res.interval,
    expiresAt: new Date(Date.now() + res.expiresIn * 1000),
  };
}

export interface PollLoginResult {
  success: boolean;
  pending?: boolean;
}

export async function pollForLogin(
  profileName: string,
  deviceCode: string,
  sessionId: string
): Promise<PollLoginResult> {
  const profile = loadSsoProfiles().find((p) => p.name === profileName);
  if (!profile) {
    throw new Error(`Unknown SSO profile: ${profileName}`);
  }

  const { clientId, clientSecret } = await getRegisteredClient(
    profile.ssoRegion
  );
  const oidc = new SSOOIDCClient({ region: profile.ssoRegion });

  let tokenRes;
  try {
    tokenRes = await oidc.send(
      new CreateTokenCommand({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      })
    );
  } catch (err) {
    const anyErr = err as any;
    if (
      anyErr?.name === "AuthorizationPendingException" ||
      anyErr?.error === "authorization_pending"
    ) {
      return { success: false, pending: true };
    }
    throw err;
  }

  if (!tokenRes.accessToken || !tokenRes.expiresIn) {
    throw new Error("Failed to obtain SSO access token");
  }
  const expiresAt = new Date(Date.now() + tokenRes.expiresIn * 1000);

  setSsoSession(sessionId, {
    ssoSession: profile.ssoSession,
    ssoRegion: profile.ssoRegion,
    accessToken: tokenRes.accessToken,
    expiresAt,
  });

  return { success: true };
}
