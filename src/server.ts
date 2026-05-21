import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { getEnvironment, registerDynamicEnvironments } from "./aws/envConfig";
import { loadSsoProfiles } from "./aws/ssoProfiles";
import { startLogin, pollForLogin } from "./aws/ssoLogin";
import { discoverSsoEnvironments } from "./aws/ssoDiscovery";
import { getSsoSession } from "./aws/sessionStore";
import {
  loadSecret,
  saveSecret,
  listVersions,
  loadVersion,
} from "./aws/secretsService";

const app = express();
const port = process.env.PORT || 3000;

/** Extract a meaningful error message from AWS SDK or generic errors */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as any;
    // AWS SDK errors often have name but empty message
    const message = err.message || anyErr.name || "Unknown error";
    const code = anyErr.Code || anyErr.code || anyErr.$metadata?.httpStatusCode;
    return code ? `${message} (${code})` : message;
  }
  return String(err);
}

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Health endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// List SSO profiles from ~/.aws/config
app.get("/api/sso-profiles", (_req, res) => {
  try {
    const profiles = loadSsoProfiles();
    res.json(profiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Rate limiter for SSO auth endpoints
const ssoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Rate limiter for write operations
const writeRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many write requests, please try again later" },
});

// Start SSO device authorization flow
app.post("/api/sso/login/start", ssoRateLimiter, async (req, res) => {
  const { profileName } = req.body ?? {};
  if (!profileName) {
    res.status(400).json({ error: "profileName is required" });
    return;
  }

  try {
    const result = await startLogin(profileName);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Poll SSO login completion
app.post("/api/sso/login/poll", ssoRateLimiter, async (req, res) => {
  const { profileName, deviceCode, sessionId } = req.body ?? {};
  if (!profileName || !deviceCode || !sessionId) {
    res.status(400).json({
      error: "profileName, deviceCode and sessionId are required",
    });
    return;
  }

  try {
    const result = await pollForLogin(profileName, deviceCode, sessionId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Discover SSO environments (filtered to sandbox/staging/production)
app.get("/api/sso/environments", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  try {
    const session = getSsoSession(sessionId);
    if (!session) {
      res.status(401).json({
        error: "No active SSO session. Please connect first.",
      });
      return;
    }

    const envs = await discoverSsoEnvironments(session);
    registerDynamicEnvironments(sessionId, envs);
    res.json(envs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Load the ALL_ORGANIZATION_SETTINGS value from the secret
app.get("/api/secret", async (req, res) => {
  const envId = req.query.envId as string;
  const sessionId = req.query.sessionId as string;

  if (!envId || !sessionId) {
    res.status(400).json({ error: "envId and sessionId are required" });
    return;
  }

  try {
    const env = getEnvironment(envId, sessionId);
    const result = await loadSecret(envId, sessionId);
    res.json({ ...result, environment: env.accountName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Save updated ALL_ORGANIZATION_SETTINGS value
app.put("/api/secret", writeRateLimiter, async (req, res) => {
  const { envId, sessionId, value } = req.body ?? {};

  if (!envId || !sessionId || value === undefined) {
    res.status(400).json({
      error: "envId, sessionId and value are required",
    });
    return;
  }

  try {
    const env = getEnvironment(envId, sessionId);
    const result = await saveSecret(envId, sessionId, value);
    res.json({
      ...result,
      environment: env.accountName,
      message: "Secret updated successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// List secret versions
app.get("/api/secret/versions", async (req, res) => {
  const envId = req.query.envId as string;
  const sessionId = req.query.sessionId as string;

  if (!envId || !sessionId) {
    res.status(400).json({ error: "envId and sessionId are required" });
    return;
  }

  try {
    const versions = await listVersions(envId, sessionId);
    res.json({ versions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Load a specific version of the secret
app.get("/api/secret/version/:versionId", async (req, res) => {
  const versionId = req.params.versionId;
  const envId = req.query.envId as string;
  const sessionId = req.query.sessionId as string;

  if (!envId || !sessionId) {
    res.status(400).json({ error: "envId and sessionId are required" });
    return;
  }

  try {
    const result = await loadVersion(envId, sessionId, versionId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: extractErrorMessage(err) });
  }
});

// Serve frontend
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
