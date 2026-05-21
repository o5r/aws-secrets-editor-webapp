import fs from "fs";
import os from "os";
import path from "path";
import ini from "ini";

export interface SsoProfile {
  name: string;
  displayName: string;
  defaultRegion?: string;
  ssoStartUrl: string;
  ssoRegion: string;
  ssoAccountId: string;
  ssoRoleName: string;
  ssoSession: string;
}

export function loadSsoProfiles(): SsoProfile[] {
  const configPath = path.join(os.homedir(), ".aws", "config");

  if (!fs.existsSync(configPath)) {
    return [];
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = ini.parse(raw);

  const sessions: Record<
    string,
    { ssoStartUrl: string; ssoRegion: string }
  > = {};

  for (const sectionName of Object.keys(parsed)) {
    const section = parsed[sectionName] as Record<string, string> | undefined;
    if (!section) continue;

    if (sectionName.startsWith("sso-session ")) {
      const sessionName = sectionName.replace(/^sso-session\s+/, "");
      if (section.sso_start_url && section.sso_region) {
        sessions[sessionName] = {
          ssoStartUrl: section.sso_start_url,
          ssoRegion: section.sso_region,
        };
      }
    }
  }

  const profiles: SsoProfile[] = [];

  for (const sectionName of Object.keys(parsed)) {
    const section = parsed[sectionName] as Record<string, string> | undefined;
    if (!section) continue;

    if (!sectionName.startsWith("profile ")) continue;

    const name = sectionName.replace(/^profile\s+/, "");

    const ssoSessionName = section.sso_session;
    const session = ssoSessionName ? sessions[ssoSessionName] : undefined;

    if (
      !session ||
      !section.sso_account_id ||
      !section.sso_role_name
    ) {
      continue;
    }

    profiles.push({
      name,
      displayName: name,
      defaultRegion: section.region,
      ssoStartUrl: session.ssoStartUrl,
      ssoRegion: session.ssoRegion,
      ssoAccountId: section.sso_account_id,
      ssoRoleName: section.sso_role_name,
      ssoSession: ssoSessionName,
    });
  }

  return profiles;
}
