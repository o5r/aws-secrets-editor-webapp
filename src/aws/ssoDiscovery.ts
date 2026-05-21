import {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  AccountInfo,
  RoleInfo,
} from "@aws-sdk/client-sso";
import type { ConnectedSsoSession } from "./sessionStore";
import type { EnvironmentConfig } from "./credentials";

/** Environments that have the ALL_ORGANIZATIONS_SETTINGS secret */
const ALLOWED_ENVIRONMENTS = ["sandbox", "staging", "production"];

/**
 * Discover all accessible AWS accounts and roles using an active SSO
 * access token. Only returns environments matching sandbox/staging/production.
 */
export async function discoverSsoEnvironments(
  session: ConnectedSsoSession
): Promise<EnvironmentConfig[]> {
  const sso = new SSOClient({ region: session.ssoRegion });

  const accounts: AccountInfo[] = [];
  let nextToken: string | undefined;

  do {
    const res = await sso.send(
      new ListAccountsCommand({
        accessToken: session.accessToken,
        nextToken,
      })
    );
    accounts.push(...(res.accountList ?? []));
    nextToken = res.nextToken;
  } while (nextToken);

  const environments: EnvironmentConfig[] = [];

  for (const account of accounts) {
    if (!account.accountId) continue;

    const accountName = account.accountName || account.accountId;
    const accountNameLower = accountName.toLowerCase();

    // Only include accounts whose name contains sandbox, staging, or production
    const matchedEnv = ALLOWED_ENVIRONMENTS.find((env) =>
      accountNameLower.includes(env)
    );
    if (!matchedEnv) continue;

    const roles: RoleInfo[] = [];
    let roleNextToken: string | undefined;

    do {
      const res = await sso.send(
        new ListAccountRolesCommand({
          accessToken: session.accessToken,
          accountId: account.accountId,
          nextToken: roleNextToken,
        })
      );
      roles.push(...(res.roleList ?? []));
      roleNextToken = res.nextToken;
    } while (roleNextToken);

    for (const role of roles) {
      if (!role.roleName) continue;

      environments.push({
        id: `${account.accountId}-${role.roleName}`,
        label: `${accountName} (${role.roleName})`,
        accountName: matchedEnv,
        regions: ["eu-west-1"],
        ssoAccountId: account.accountId,
        ssoRoleName: role.roleName,
      });
    }
  }

  return environments;
}
