import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { loadSsoProfiles } from "../../src/aws/ssoProfiles";

vi.mock("fs");

describe("ssoProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when config file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadSsoProfiles()).toEqual([]);
  });

  it("parses SSO profiles from config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[sso-session my-sso]
sso_start_url = https://start.example.com
sso_region = eu-west-1

[profile sandbox_admin]
sso_session = my-sso
sso_account_id = 111111111111
sso_role_name = Admin
region = eu-west-1

[profile staging_admin]
sso_session = my-sso
sso_account_id = 222222222222
sso_role_name = Admin
`);

    const profiles = loadSsoProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({
      name: "sandbox_admin",
      displayName: "sandbox_admin",
      defaultRegion: "eu-west-1",
      ssoStartUrl: "https://start.example.com",
      ssoRegion: "eu-west-1",
      ssoAccountId: "111111111111",
      ssoRoleName: "Admin",
      ssoSession: "my-sso",
    });
    expect(profiles[1].name).toBe("staging_admin");
    expect(profiles[1].defaultRegion).toBeUndefined();
  });

  it("skips profiles without sso_session reference", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[profile no-sso]
region = us-east-1
`);

    expect(loadSsoProfiles()).toEqual([]);
  });

  it("skips profiles with missing sso_account_id or sso_role_name", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[sso-session my-sso]
sso_start_url = https://start.example.com
sso_region = eu-west-1

[profile missing-account]
sso_session = my-sso
sso_role_name = Admin

[profile missing-role]
sso_session = my-sso
sso_account_id = 111111111111
`);

    expect(loadSsoProfiles()).toEqual([]);
  });

  it("skips sso-session sections with missing fields", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[sso-session incomplete]
sso_start_url = https://start.example.com

[profile test]
sso_session = incomplete
sso_account_id = 111111111111
sso_role_name = Admin
`);

    expect(loadSsoProfiles()).toEqual([]);
  });

  it("skips sections that are not profiles or sso-sessions", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[default]
region = us-east-1

[sso-session my-sso]
sso_start_url = https://start.example.com
sso_region = eu-west-1

[profile valid]
sso_session = my-sso
sso_account_id = 111111111111
sso_role_name = Admin
`);

    const profiles = loadSsoProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("valid");
  });
});
