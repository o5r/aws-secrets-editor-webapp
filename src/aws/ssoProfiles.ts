import fs from "fs";
import os from "os";
import path from "path";

/**
 * Minimal AWS config parser.
 *
 * We can't use the generic `ini` package because it treats dots inside
 * section names as nested-key separators, which breaks AWS profile names
 * like `DL-DevOps.710818749406-710818749406`.
 */
function parseAwsConfig(raw: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentSection: string | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[") && line.includes("]")) {
      const end = line.indexOf("]");
      currentSection = line.slice(1, end).trim();
      if (!result[currentSection]) result[currentSection] = {};
      // Ignore any trailing content after ']' on the same line.
      continue;
    }

    if (!currentSection) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) result[currentSection][key] = value;
  }

  return result;
}

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
  const parsed = parseAwsConfig(raw);

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
