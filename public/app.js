import {
  JSONEditor,
} from "https://cdn.jsdelivr.net/npm/vanilla-jsoneditor@2/standalone.js";
import { decodeSettings, encodeSettings } from "./secretCodec.js";

// ── State ──────────────────────────────────────────────────────────────
const MODE_AWS = "aws";
const MODE_LOCAL = "local";

let mode = MODE_AWS;
let sessionId = null;
let currentProfileName = null;
let currentEnvId = null;
let currentEnvName = null;
let originalValue = null; // The value as loaded from AWS (or pasted, in local mode)
let localSourceValue = null; // The exact base64 string pasted in local mode
let editor = null;
let versionViewerEditor = null;
let versionToRestore = null;
let pollTimer = null;
let saveSessionTimer = null;
let selectedVersions = []; // {versionId, createdDate} — max 2 for comparison
let versionsData = []; // cached version list from last loadVersionHistory
let ecsServices = []; // marketplace API services for the current environment
let selectedEcsServices = []; // subset of ecsServices to restart
let ecsPollTimer = null;

// ── Helpers ────────────────────────────────────────────────────────────
function setStatus(elId, message, type = "info") {
  const el = document.getElementById(elId);
  el.className = `status ${type}`;
  el.innerHTML = message;
  el.style.display = "block";
}

function clearStatus(elId) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  el.style.display = "none";
  el.className = "status";
}

function generateSessionId() {
  return "sess-" + crypto.randomUUID();
}

// ── Session Persistence ───────────────────────────────────────────────
const SESSION_KEY = "aws-secrets-editor-session";
const IDB_NAME = "aws-secrets-editor";
const IDB_STORE = "keys";
const IDB_KEY_ID = "session-encryption-key";

// In-memory cache of the encryption key
let encryptionKey = null;

function openKeyStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;

  // Try to load existing key from IndexedDB
  try {
    const db = await openKeyStore();
    const existing = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (existing) {
      encryptionKey = existing;
      return encryptionKey;
    }
  } catch {
    // IndexedDB unavailable — fall through to generate new key
  }

  // Generate a new key
  encryptionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // not extractable
    ["encrypt", "decrypt"]
  );

  // Persist to IndexedDB (survives refresh, cleared on tab close via clearSession)
  try {
    const db = await openKeyStore();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const req = tx.objectStore(IDB_STORE).put(encryptionKey, IDB_KEY_ID);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Non-critical — key still works in memory for this page lifetime
  }

  return encryptionKey;
}

async function encryptData(plaintext) {
  const key = await getEncryptionKey();
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );
  // Store IV + ciphertext as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptData(encoded) {
  const key = await getEncryptionKey();
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

async function saveSession() {
  try {
    let editorContent = null;
    if (editor) {
      const content = editor.get();
      if (content.json !== undefined) editorContent = content.json;
      else if (content.text !== undefined) editorContent = JSON.parse(content.text);
    }

    const state = {
      mode,
      sessionId,
      currentProfileName,
      currentEnvId,
      currentEnvName,
      originalValue,
      localSourceValue,
      editorContent,
      timestamp: Date.now(),
    };
    const encrypted = await encryptData(JSON.stringify(state));
    sessionStorage.setItem(SESSION_KEY, encrypted);
  } catch {
    // Ignore serialization/encryption errors
  }
}

function debouncedSaveSession() {
  if (saveSessionTimer) clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(saveSession, 2000);
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  encryptionKey = null;
  // Clean up IndexedDB key
  openKeyStore()
    .then((db) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY_ID);
    })
    .catch(() => {});
}

async function getSavedSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const decrypted = await decryptData(raw);
    return JSON.parse(decrypted);
  } catch {
    // Decryption fails if key changed (new tab) — expected behavior
    clearSession();
    return null;
  }
}

async function restoreSession() {
  const saved = await getSavedSession();
  if (!saved) return false;

  if (saved.mode === MODE_LOCAL) {
    mode = MODE_LOCAL;
    applyMode();
    return restoreLocalSession(saved);
  }

  if (!saved.sessionId || !saved.currentEnvId) return false;

  // Validate the backend session is still alive
  try {
    await api("GET", `/api/sso/environments?sessionId=${saved.sessionId}`);
  } catch {
    clearSession();
    return false;
  }

  // Restore state
  sessionId = saved.sessionId;
  currentProfileName = saved.currentProfileName;
  currentEnvId = saved.currentEnvId;
  currentEnvName = saved.currentEnvName;
  originalValue = saved.originalValue;

  // Mark step 1 done and set status
  markStepDone(1);
  setStatus("ssoStatus", "Session restored from previous connection.", "success");

  // Select the right profile in dropdown
  const profileSel = document.getElementById("ssoProfile");
  if (currentProfileName) {
    for (const opt of profileSel.options) {
      if (opt.value === currentProfileName) {
        opt.selected = true;
        break;
      }
    }
  }

  // Load environments and select the right one
  await loadEnvironments();
  const envSel = document.getElementById("envSelect");
  for (const opt of envSel.options) {
    if (opt.value === currentEnvId) {
      opt.selected = true;
      break;
    }
  }

  // Update badges
  const badge = document.getElementById("envBadge");
  badge.textContent = currentEnvName;
  badge.className = `env-badge ${currentEnvName}`;
  document.getElementById("sessionBadge").classList.remove("hidden");
  markStepDone(2);

  // Initialize editor with saved content or originalValue
  const valueToLoad = saved.editorContent || originalValue;
  if (valueToLoad) {
    initEditor(valueToLoad);
    openStep("step3");

    // If editorContent differs from originalValue, mark as changed
    if (saved.editorContent && JSON.stringify(saved.editorContent) !== JSON.stringify(originalValue)) {
      setReviewEnabled(true);
      document.getElementById("editorStatus").textContent = "Unsaved changes (restored from session)";
      setStatus("editorMainStatus", "Your unsaved changes have been restored.", "warning");
    }

    loadVersionHistory();
    openStep("step4");
  }

  loadEcsServices();

  setStatus("envStatus", "Session restored. Environment re-selected.", "success");
  return true;
}

/** Local mode has no backend session to validate — just rehydrate the editor. */
function restoreLocalSession(saved) {
  localSourceValue = saved.localSourceValue ?? null;
  originalValue = saved.originalValue ?? null;

  if (localSourceValue) {
    document.getElementById("localInput").value = localSourceValue;
    document.getElementById("btnLocalDecode").disabled = false;
  }

  const valueToLoad = saved.editorContent ?? originalValue;
  if (!valueToLoad) return false;

  initEditor(valueToLoad);
  markStepDone("Local");
  openStep("step3");
  invalidateLocalOutput();

  if (
    saved.editorContent &&
    JSON.stringify(saved.editorContent) !== JSON.stringify(originalValue)
  ) {
    setReviewEnabled(true);
    document.getElementById("editorStatus").textContent =
      "Unsaved changes (restored from session)";
    setStatus("editorMainStatus", "Your unsaved changes have been restored.", "warning");
  }

  setStatus("localStatus", "Value restored from your previous session.", "success");
  return true;
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Step toggling ──────────────────────────────────────────────────────
window.toggleStep = function (stepId) {
  document.getElementById(stepId).classList.toggle("open");
};

function openStep(stepId) {
  document.getElementById(stepId).classList.add("open");
}

function markStepDone(num) {
  document.getElementById(`step${num}-num`).classList.add("done");
}

// ── Mode: AWS (live secret) vs Local (offline base64) ─────────────────
function isLocal() {
  return mode === MODE_LOCAL;
}

const MODE_DESCRIPTIONS = {
  [MODE_AWS]: "Connect through AWS SSO to read and update the live secret.",
  [MODE_LOCAL]:
    "Paste a base64 value, edit it, and copy the re-encoded result. " +
    "Nothing leaves your browser and no AWS credentials are needed.",
};

function applyMode() {
  const local = isLocal();

  for (const el of document.querySelectorAll(".aws-only")) {
    el.classList.toggle("hidden", local);
  }
  for (const el of document.querySelectorAll(".local-only")) {
    el.classList.toggle("hidden", !local);
  }

  document.getElementById("modeOptionAws").classList.toggle("active", !local);
  document.getElementById("modeOptionLocal").classList.toggle("active", local);
  document.querySelector(`input[name="appMode"][value="${mode}"]`).checked = true;
  document.getElementById("modeDescription").textContent = MODE_DESCRIPTIONS[mode];

  // Step numbering differs: AWS is 1-SSO 2-Env 3-Edit 4-Restart,
  // local is just 1-Paste 2-Edit.
  document.getElementById("step3-num").textContent = local ? "2" : "3";

  const badge = document.getElementById("envBadge");
  const sessionBadge = document.getElementById("sessionBadge");
  if (local) {
    badge.textContent = "local";
    badge.className = "env-badge local";
    sessionBadge.classList.remove("hidden");
  } else if (currentEnvName) {
    badge.textContent = currentEnvName;
    badge.className = `env-badge ${currentEnvName}`;
    sessionBadge.classList.remove("hidden");
  } else {
    sessionBadge.classList.add("hidden");
  }
}

/** Reset everything that belongs to the mode we are leaving. */
function resetForModeSwitch() {
  stopEcsPolling();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (editor) {
    editor.destroy();
    editor = null;
  }
  document.getElementById("jsoneditor").innerHTML = "";

  originalValue = null;
  localSourceValue = null;
  ecsServices = [];
  selectedEcsServices = [];
  selectedVersions = [];
  versionsData = [];

  setReviewEnabled(false);
  document.getElementById("editorStatus").textContent = "";
  document.getElementById("localInput").value = "";
  document.getElementById("btnLocalDecode").disabled = true;
  document.getElementById("localOutputValue").value = "";
  document.getElementById("btnLocalCopy").disabled = true;
  document.getElementById("localOutputInfo").textContent = "";

  for (const id of [
    "ssoStatus",
    "envStatus",
    "editorMainStatus",
    "ecsStatus",
    "localStatus",
    "localOutputStatus",
  ]) {
    clearStatus(id);
  }

  for (const num of [1, 2, 3, 4]) {
    document.getElementById(`step${num}-num`).classList.remove("done");
  }
  document.getElementById("stepLocal-num").classList.remove("done");

  for (const id of ["step2", "step3", "step4"]) {
    document.getElementById(id).classList.remove("open");
  }
  document.getElementById("step1").classList.add("open");
  document.getElementById("stepLocal").classList.add("open");
}

window.setMode = function (newMode) {
  if (newMode === mode) return;

  if (hasUnsavedChanges() && !confirm(
    "You have unsaved changes in the editor. Switching mode will discard them. Continue?"
  )) {
    // Revert the radio the user just clicked
    document.querySelector(`input[name="appMode"][value="${mode}"]`).checked = true;
    return;
  }

  mode = newMode;
  resetForModeSwitch();
  applyMode();
  saveSession();
};

function hasUnsavedChanges() {
  if (!editor || originalValue === null) return false;
  try {
    return JSON.stringify(getEditorValue()) !== JSON.stringify(originalValue);
  } catch {
    return true;
  }
}

/** The "Review Changes" button differs per mode; drive both from one place. */
function setReviewEnabled(enabled) {
  document.getElementById("btnReview").disabled = !enabled;
  document.getElementById("btnLocalDiff").disabled = !enabled;
}

// ── Step 1: SSO Connection ─────────────────────────────────────────────
async function loadProfiles() {
  try {
    const profiles = await api("GET", "/api/sso-profiles");
    const sel = document.getElementById("ssoProfile");
    sel.innerHTML = "";
    if (profiles.length === 0) {
      sel.innerHTML = '<option value="">No SSO profiles found</option>';
      return;
    }
    // Deduplicate by ssoSession name (we only need one profile per SSO session)
    const seen = new Set();
    for (const p of profiles) {
      if (seen.has(p.ssoSession)) continue;
      seen.add(p.ssoSession);
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.ssoSession;
      sel.appendChild(opt);
    }
  } catch (err) {
    setStatus("ssoStatus", `Failed to load profiles: ${err.message}`, "error");
  }
}

window.startSsoLogin = async function () {
  const profileName = document.getElementById("ssoProfile").value;
  if (!profileName) return;

  currentProfileName = profileName;
  sessionId = generateSessionId();

  document.getElementById("btnConnect").disabled = true;
  setStatus("ssoStatus", '<span class="loading-spinner"></span>Starting SSO login...', "info");

  try {
    const result = await api("POST", "/api/sso/login/start", { profileName });

    setStatus(
      "ssoStatus",
      `<span class="loading-spinner"></span>Please authorize in your browser. Code: <strong>${result.userCode}</strong><br>` +
        `<a class="sso-link" href="${result.verificationUri}" target="_blank" rel="noopener">${result.verificationUri}</a>`,
      "info"
    );

    // Auto-open the verification URL
    window.open(result.verificationUri, "_blank");

    // Start polling
    startPolling(profileName, result.deviceCode, result.intervalSeconds);
  } catch (err) {
    setStatus("ssoStatus", `Login failed: ${err.message}`, "error");
    document.getElementById("btnConnect").disabled = false;
  }
};

function startPolling(profileName, deviceCode, interval) {
  if (pollTimer) clearInterval(pollTimer);
  let consecutiveErrors = 0;
  const maxErrors = 5;

  pollTimer = setInterval(async () => {
    try {
      const result = await api("POST", "/api/sso/login/poll", {
        profileName,
        deviceCode,
        sessionId,
      });

      consecutiveErrors = 0; // Reset on success

      if (result.success) {
        clearInterval(pollTimer);
        pollTimer = null;
        setStatus("ssoStatus", "Connected successfully!", "success");
        markStepDone(1);
        document.getElementById("btnConnect").disabled = false;
        saveSession();
        await loadEnvironments();
      }
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= maxErrors) {
        clearInterval(pollTimer);
        pollTimer = null;
        setStatus(
          "ssoStatus",
          `Polling failed after ${maxErrors} attempts: ${err.message}. ` +
            `Click "Connect with SSO" to retry.`,
          "error"
        );
        document.getElementById("btnConnect").disabled = false;
      } else {
        setStatus(
          "ssoStatus",
          `<span class="loading-spinner"></span>Network error (attempt ${consecutiveErrors}/${maxErrors}), retrying... ` +
            `<br><small>${err.message}</small>`,
          "warning"
        );
      }
    }
  }, (interval || 5) * 1000);
}

// ── Step 2: Environment Selection ──────────────────────────────────────
async function loadEnvironments() {
  openStep("step2");
  setStatus("envStatus", '<span class="loading-spinner"></span>Loading environments...', "info");

  try {
    const envs = await api("GET", `/api/sso/environments?sessionId=${sessionId}`);
    const sel = document.getElementById("envSelect");
    sel.innerHTML = '<option value="">Select environment...</option>';

    for (const env of envs) {
      const opt = document.createElement("option");
      opt.value = env.id;
      opt.dataset.accountName = env.accountName;
      opt.textContent = env.label;
      sel.appendChild(opt);
    }

    clearStatus("envStatus");
  } catch (err) {
    setStatus("envStatus", `Failed to load environments: ${err.message}`, "error");
  }
}

window.loadSecretValue = async function () {
  const sel = document.getElementById("envSelect");
  const envId = sel.value;
  if (!envId) return;

  currentEnvId = envId;
  currentEnvName = sel.options[sel.selectedIndex].dataset.accountName;

  // Environment changed — drop any ECS state from the previous one
  stopEcsPolling();
  ecsServices = [];
  selectedEcsServices = [];

  // Update badges
  const badge = document.getElementById("envBadge");
  badge.textContent = currentEnvName;
  badge.className = `env-badge ${currentEnvName}`;
  document.getElementById("sessionBadge").classList.remove("hidden");

  setStatus("envStatus", '<span class="loading-spinner"></span>Loading secret...', "info");

  try {
    const result = await api("GET", `/api/secret?envId=${envId}&sessionId=${sessionId}`);
    originalValue = JSON.parse(JSON.stringify(result.value)); // deep clone

    setStatus("envStatus", `Secret loaded (version: ${result.versionId?.substring(0, 8)}...)`, "success");
    markStepDone(2);

    // Initialize editor
    initEditor(result.value);
    openStep("step3");
    openStep("step4");

    // Load version history
    loadVersionHistory();
    loadEcsServices();
    saveSession();
  } catch (err) {
    setStatus("envStatus", `Failed to load secret: ${err.message}`, "error");
  }
};

// ── Step 3: JSON Editor ────────────────────────────────────────────────
function initEditor(value) {
  const container = document.getElementById("jsoneditor");
  container.innerHTML = "";

  if (editor) {
    editor.destroy();
    editor = null;
  }

  editor = new JSONEditor({
    target: container,
    props: {
      content: { json: value },
      mode: "tree",
      mainMenuBar: true,
      navigationBar: true,
      statusBar: true,
      onChange: (content) => {
        const hasChanges = detectChanges(content);
        setReviewEnabled(hasChanges);
        document.getElementById("editorStatus").textContent = hasChanges
          ? "Unsaved changes"
          : "No changes";
        if (isLocal()) invalidateLocalOutput();
        debouncedSaveSession();
      },
    },
  });

  setReviewEnabled(false);
  document.getElementById("editorStatus").textContent = "No changes";
}

function detectChanges(content) {
  try {
    let current;
    if (content.json !== undefined) {
      current = content.json;
    } else if (content.text !== undefined) {
      current = JSON.parse(content.text);
    } else {
      return false;
    }
    return JSON.stringify(current) !== JSON.stringify(originalValue);
  } catch {
    // Parse error in text mode - consider it changed
    return true;
  }
}

function getEditorValue() {
  const content = editor.get();
  if (content.json !== undefined) return content.json;
  if (content.text !== undefined) return JSON.parse(content.text);
  throw new Error("Unable to get editor value");
}

window.expandAll = function () {
  if (editor) editor.expand(() => true);
};

window.collapseAll = function () {
  if (editor) editor.expand(() => false);
};

// ── Local mode: base64 in / base64 out ────────────────────────────────
window.onLocalInputChange = function () {
  const value = document.getElementById("localInput").value.trim();
  document.getElementById("btnLocalDecode").disabled = value.length === 0;
  if (value.length === 0) clearStatus("localStatus");
};

window.clearLocalValue = function () {
  document.getElementById("localInput").value = "";
  document.getElementById("btnLocalDecode").disabled = true;
  clearStatus("localStatus");
};

window.decodeLocalValue = function () {
  const raw = document.getElementById("localInput").value;

  let value;
  try {
    value = decodeSettings(raw);
  } catch (err) {
    setStatus("localStatus", err.message, "error");
    return;
  }

  if (value === null || typeof value !== "object") {
    setStatus(
      "localStatus",
      "The decoded value is valid JSON but not an object — the editor expects " +
        "an ALL_ORGANIZATIONS_SETTINGS object.",
      "error"
    );
    return;
  }

  localSourceValue = raw.trim().replace(/\s+/g, "");
  originalValue = JSON.parse(JSON.stringify(value));

  initEditor(value);
  markStepDone("Local");
  openStep("step3");

  invalidateLocalOutput();
  clearStatus("editorMainStatus");

  // Re-encoding without any edit is only lossless if the source was already in
  // canonical form. Warn up-front rather than at copy time.
  const roundTripped = encodeSettings(value);
  if (roundTripped === localSourceValue) {
    setStatus("localStatus", "Value decoded. Round-trip is lossless.", "success");
  } else {
    setStatus(
      "localStatus",
      "Value decoded. Note: re-encoding normalizes formatting, so the output " +
        "will differ from your input even without edits (the decoded JSON is " +
        "unchanged).",
      "warning"
    );
  }

  document.getElementById("step3").scrollIntoView({ behavior: "smooth", block: "start" });
  saveSession();
};

function invalidateLocalOutput() {
  document.getElementById("localOutputValue").value = "";
  document.getElementById("btnLocalCopy").disabled = true;
  document.getElementById("localOutputInfo").textContent = "Not generated yet";
  clearStatus("localOutputStatus");
}

window.encodeLocalValue = function () {
  let value;
  try {
    value = getEditorValue();
  } catch (err) {
    setStatus("localOutputStatus", `Invalid JSON: ${err.message}`, "error");
    return;
  }

  const encoded = encodeSettings(value);
  document.getElementById("localOutputValue").value = encoded;
  document.getElementById("btnLocalCopy").disabled = false;
  document.getElementById("localOutputInfo").textContent = `${encoded.length} characters`;

  if (localSourceValue && encoded === localSourceValue) {
    setStatus("localOutputStatus", "Identical to the value you pasted.", "info");
  } else {
    clearStatus("localOutputStatus");
  }

  markStepDone(3);
};

window.copyLocalOutput = async function () {
  const encoded = document.getElementById("localOutputValue").value;
  if (!encoded) return;

  try {
    await navigator.clipboard.writeText(encoded);
    setStatus("localOutputStatus", "Copied to clipboard.", "success");
  } catch {
    // Clipboard API needs a secure context — fall back to manual selection
    const area = document.getElementById("localOutputValue");
    area.select();
    setStatus(
      "localOutputStatus",
      "Clipboard unavailable — the value is selected, press Ctrl/Cmd+C.",
      "warning"
    );
  }
};

// ── Diff & Save Flow ──────────────────────────────────────────────────
window.reviewChanges = function () {
  let newValue;
  try {
    newValue = getEditorValue();
  } catch (err) {
    setStatus("editorMainStatus", `Invalid JSON: ${err.message}`, "error");
    return;
  }

  const diff = generateDiff(originalValue, newValue);
  document.getElementById("diffContent").innerHTML = diff;

  if (!isLocal()) {
    const diffBadge = document.getElementById("diffEnvBadge");
    diffBadge.textContent = currentEnvName;
    diffBadge.className = `env-badge ${currentEnvName}`;
  }

  document.getElementById("diffModal").classList.add("active");
};

window.closeDiffModal = function () {
  document.getElementById("diffModal").classList.remove("active");
};

window.confirmSave = function () {
  closeDiffModal();

  const confirmBadge = document.getElementById("confirmEnvBadge");
  confirmBadge.textContent = currentEnvName;
  confirmBadge.className = `env-badge ${currentEnvName}`;

  document.getElementById("confirmInput").value = "";
  document.getElementById("btnFinalSave").disabled = true;
  document.getElementById("confirmModal").classList.add("active");
  document.getElementById("confirmInput").focus();
};

window.closeConfirmModal = function () {
  document.getElementById("confirmModal").classList.remove("active");
};

window.checkConfirmInput = function () {
  const input = document.getElementById("confirmInput").value.trim().toLowerCase();
  document.getElementById("btnFinalSave").disabled = input !== currentEnvName;
};

window.finalSave = async function () {
  let newValue;
  try {
    newValue = getEditorValue();
  } catch (err) {
    setStatus("editorMainStatus", `Invalid JSON: ${err.message}`, "error");
    closeConfirmModal();
    return;
  }

  document.getElementById("btnFinalSave").disabled = true;
  document.getElementById("btnFinalSave").textContent = "Saving...";

  try {
    const result = await api("PUT", "/api/secret", {
      envId: currentEnvId,
      sessionId,
      value: newValue,
    });

    closeConfirmModal();
    originalValue = JSON.parse(JSON.stringify(newValue));
    setReviewEnabled(false);
    document.getElementById("editorStatus").textContent = "No changes";

    setStatus(
      "editorMainStatus",
      `Secret updated successfully! New version: ${result.versionId?.substring(0, 8)}...` +
        `<br><small>Go to step 4 to restart the marketplace API — the running tasks ` +
        `are still using the previous value.</small>`,
      "success"
    );

    // Refresh version history
    loadVersionHistory();

    // Surface step 4: the change is not live until the tasks are replaced
    openStep("step4");
    await loadEcsServices();
    setStatus(
      "ecsStatus",
      "The secret changed — restart the services below to apply it.",
      "warning"
    );
    document.getElementById("step4").scrollIntoView({ behavior: "smooth", block: "start" });

    saveSession();
  } catch (err) {
    closeConfirmModal();
    setStatus("editorMainStatus", `Failed to save: ${err.message}`, "error");
  } finally {
    document.getElementById("btnFinalSave").textContent = "Save to AWS";
    document.getElementById("btnFinalSave").disabled = false;
  }
};

// ── Version History ────────────────────────────────────────────────────
window.loadVersionHistory = async function () {
  if (!currentEnvId || !sessionId) return;

  const list = document.getElementById("versionList");
  list.innerHTML = '<li style="color: var(--text-muted); font-size: 0.8rem; padding: 8px;"><span class="loading-spinner"></span>Loading...</li>';
  selectedVersions = [];
  updateCompareButton();

  try {
    const data = await api("GET", `/api/secret/versions?envId=${currentEnvId}&sessionId=${sessionId}`);
    versionsData = data.versions;
    list.innerHTML = "";

    if (data.versions.length === 0) {
      list.innerHTML = '<li style="color: var(--text-muted); font-size: 0.8rem; padding: 8px;">No versions found</li>';
      return;
    }

    for (const v of data.versions) {
      const li = document.createElement("li");
      li.className = "version-item";
      li.dataset.versionId = v.versionId;

      const date = v.createdDate ? new Date(v.createdDate).toLocaleString() : "Unknown date";
      const stages = (v.versionStages || [])
        .map((s) => {
          const cls = s === "AWSCURRENT" ? "current" : s === "AWSPREVIOUS" ? "previous" : "";
          return `<span class="version-stage ${cls}">${s}</span>`;
        })
        .join(" ");

      li.innerHTML =
        `<div class="version-item-row">` +
          `<input type="checkbox" class="version-checkbox" data-version-id="${v.versionId}" data-created-date="${v.createdDate || ""}" title="Select for comparison" />` +
          `<div class="version-item-content">` +
            `<div class="version-date">${date}</div>` +
            `<div>${stages}</div>` +
            `<div class="version-id">${v.versionId}</div>` +
          `</div>` +
        `</div>`;

      // Click on content area to view, checkbox for compare selection
      li.querySelector(".version-item-content").onclick = () => viewVersion(v.versionId);
      li.querySelector(".version-checkbox").onclick = (e) => {
        e.stopPropagation();
        toggleVersionSelection(v.versionId, v.createdDate, e.target);
      };

      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li style="color: var(--danger); font-size: 0.8rem; padding: 8px;">Error: ${err.message}</li>`;
  }
};

function toggleVersionSelection(versionId, createdDate, checkbox) {
  const idx = selectedVersions.findIndex((v) => v.versionId === versionId);
  if (idx >= 0) {
    // Deselect
    selectedVersions.splice(idx, 1);
    checkbox.checked = false;
  } else {
    if (selectedVersions.length >= 2) {
      // Uncheck the oldest selection
      const removed = selectedVersions.shift();
      const oldCheckbox = document.querySelector(`.version-checkbox[data-version-id="${removed.versionId}"]`);
      if (oldCheckbox) oldCheckbox.checked = false;
      const oldLi = oldCheckbox?.closest(".version-item");
      if (oldLi) oldLi.classList.remove("selected");
    }
    selectedVersions.push({ versionId, createdDate });
    checkbox.checked = true;
  }

  // Update selected styling
  document.querySelectorAll(".version-item").forEach((li) => {
    const isSelected = selectedVersions.some((v) => v.versionId === li.dataset.versionId);
    li.classList.toggle("selected", isSelected);
  });

  updateCompareButton();
}

function updateCompareButton() {
  const btn = document.getElementById("btnCompare");
  const hint = document.getElementById("compareHint");
  if (selectedVersions.length === 2) {
    btn.disabled = false;
    hint.textContent = "2 versions selected";
  } else if (selectedVersions.length === 1) {
    btn.disabled = true;
    hint.textContent = "Select 1 more version to compare";
  } else {
    btn.disabled = true;
    hint.textContent = "Select 2 versions to compare";
  }
}

window.compareVersions = async function () {
  if (selectedVersions.length !== 2) return;

  const btn = document.getElementById("btnCompare");
  btn.disabled = true;
  btn.textContent = "Loading...";

  try {
    // Sort by date — older first (left side of diff), newer second (right side)
    const sorted = [...selectedVersions].sort(
      (a, b) => new Date(a.createdDate) - new Date(b.createdDate)
    );

    const [older, newer] = await Promise.all(
      sorted.map((v) =>
        api("GET", `/api/secret/version/${encodeURIComponent(v.versionId)}?envId=${currentEnvId}&sessionId=${sessionId}`)
      )
    );

    const olderDate = sorted[0].createdDate ? new Date(sorted[0].createdDate).toLocaleString() : "Unknown";
    const newerDate = sorted[1].createdDate ? new Date(sorted[1].createdDate).toLocaleString() : "Unknown";

    document.getElementById("compareLabels").innerHTML =
      `<span style="color: var(--diff-remove-text);">&#x25CF; Older: ${olderDate}</span>` +
      `<span style="margin: 0 8px;">vs</span>` +
      `<span style="color: var(--diff-add-text);">&#x25CF; Newer: ${newerDate}</span>` +
      `<br><span style="font-family: monospace; font-size: 0.7rem;">${sorted[0].versionId} &rarr; ${sorted[1].versionId}</span>`;

    const olderValue = older.value ?? {};
    const newerValue = newer.value ?? {};

    const diff = generateDiff(olderValue, newerValue);
    document.getElementById("compareContent").innerHTML = diff;
    document.getElementById("compareModal").classList.add("active");
  } catch (err) {
    alert(`Failed to compare versions: ${err.message}`);
  } finally {
    btn.textContent = "Compare Selected";
    updateCompareButton();
  }
};

window.closeCompareModal = function () {
  document.getElementById("compareModal").classList.remove("active");
};

async function viewVersion(versionId) {
  try {
    const data = await api(
      "GET",
      `/api/secret/version/${encodeURIComponent(versionId)}?envId=${currentEnvId}&sessionId=${sessionId}`
    );

    const container = document.getElementById("versionJsonViewer");
    container.innerHTML = "";

    if (versionViewerEditor) {
      versionViewerEditor.destroy();
      versionViewerEditor = null;
    }

    if (data.value === null) {
      versionToRestore = null;
      container.innerHTML =
        '<div class="status warning" style="margin: 16px;">' +
        'This version does not contain the <strong>ALL_ORGANIZATIONS_SETTINGS</strong> key.' +
        '</div>';
      document.getElementById("btnRestoreVersion").disabled = true;
    } else {
      versionToRestore = data.value;

      versionViewerEditor = new JSONEditor({
        target: container,
        props: {
          content: { json: data.value },
          mode: "tree",
          mainMenuBar: false,
          readOnly: true,
        },
      });
      document.getElementById("btnRestoreVersion").disabled = false;
    }

    document.getElementById("versionModalId").textContent = versionId;
    document.getElementById("versionModal").classList.add("active");
  } catch (err) {
    alert(`Failed to load version: ${err.message}`);
  }
}

window.closeVersionModal = function () {
  document.getElementById("versionModal").classList.remove("active");
  if (versionViewerEditor) {
    versionViewerEditor.destroy();
    versionViewerEditor = null;
  }
};

window.restoreVersion = function () {
  if (!versionToRestore) return;

  editor.set({ json: JSON.parse(JSON.stringify(versionToRestore)) });
  closeVersionModal();
  setReviewEnabled(true);
  document.getElementById("editorStatus").textContent = "Unsaved changes (restored from version)";
  setStatus("editorMainStatus", "Version content loaded into editor. Review and save when ready.", "warning");
};

// ── ECS: Marketplace API restart (step 4) ─────────────────────────────
function stopEcsPolling() {
  if (ecsPollTimer) {
    clearInterval(ecsPollTimer);
    ecsPollTimer = null;
  }
}

function serviceKey(svc) {
  return `${svc.cluster}/${svc.serviceName}`;
}

function emptyRow(html) {
  return `<tr><td colspan="6" class="ecs-empty">${html}</td></tr>`;
}

/** Map a service to a compact state badge. */
function ecsStateBadge(svc) {
  if (svc.deploymentInProgress) return { cls: "busy", label: "deploying" };
  const rollout = svc.primaryDeployment?.rolloutState;
  if (rollout === "FAILED") return { cls: "bad", label: "failed" };
  if (svc.desiredCount === 0) return { cls: "idle", label: "stopped" };
  if (rollout === "COMPLETED") return { cls: "ok", label: "running" };
  return { cls: "idle", label: rollout || svc.status || "unknown" };
}

function updateEcsSummary() {
  const summary = document.getElementById("ecsSummary");
  const hint = document.getElementById("step4Hint");
  const btn = document.getElementById("btnRestartEcs");
  const n = selectedEcsServices.length;

  btn.disabled = n === 0;

  if (ecsServices.length === 0) {
    summary.textContent = "";
    hint.textContent = "";
    return;
  }

  summary.textContent =
    n === 0
      ? "Select at least one service"
      : `${n} of ${ecsServices.length} service(s) selected`;

  const deploying = ecsServices.filter((s) => s.deploymentInProgress).length;
  hint.textContent = deploying
    ? `${deploying} deploying`
    : `${ecsServices.length} service(s)`;
}

function renderEcsServices() {
  const body = document.getElementById("ecsServiceList");
  body.innerHTML = "";

  for (const svc of ecsServices) {
    const key = serviceKey(svc);
    const state = ecsStateBadge(svc);
    // A service scaled to 0 has nothing to restart
    const restartable = svc.desiredCount > 0;
    const checked = selectedEcsServices.some((s) => serviceKey(s) === key);

    const tr = document.createElement("tr");
    tr.className = `${checked ? "selected" : ""} ${restartable ? "" : "disabled"}`.trim();
    tr.title = restartable
      ? `${svc.serviceName}\ncluster: ${svc.cluster}`
      : `${svc.serviceName} is scaled to 0 — nothing to restart`;

    tr.innerHTML =
      `<td><input type="checkbox" ${checked ? "checked" : ""} ${restartable ? "" : "disabled"} /></td>` +
      `<td class="ecs-role">${escapeHtml(svc.role === "other" ? "service" : svc.role)}</td>` +
      `<td class="ecs-name" title="${escapeHtml(svc.serviceName)}">${escapeHtml(svc.serviceName)}</td>` +
      `<td><span class="ecs-state ${state.cls}">${escapeHtml(state.label)}</span></td>` +
      `<td class="ecs-tasks">${svc.runningCount}/${svc.desiredCount}</td>` +
      `<td class="ecs-taskdef" title="${escapeHtml(svc.taskDefinition || "")}">${escapeHtml(svc.taskDefinition || "—")}</td>`;

    const cb = tr.querySelector("input");

    const toggle = (value) => {
      if (!restartable) return;
      const idx = selectedEcsServices.findIndex((s) => serviceKey(s) === key);
      if (value && idx < 0) selectedEcsServices.push(svc);
      if (!value && idx >= 0) selectedEcsServices.splice(idx, 1);
      cb.checked = value;
      tr.classList.toggle("selected", value);
      updateEcsSummary();
    };

    cb.onclick = (e) => {
      e.stopPropagation();
      toggle(cb.checked);
    };
    tr.onclick = () => toggle(!cb.checked);

    body.appendChild(tr);
  }

  updateEcsSummary();
}

window.toggleAllEcsServices = function (select) {
  selectedEcsServices = select
    ? ecsServices.filter((svc) => svc.desiredCount > 0)
    : [];
  renderEcsServices();
};

window.loadEcsServices = async function () {
  if (!currentEnvId || !sessionId) return;

  const body = document.getElementById("ecsServiceList");
  body.innerHTML = emptyRow('<span class="loading-spinner"></span>Loading...');
  document.getElementById("btnRestartEcs").disabled = true;

  try {
    const data = await api(
      "GET",
      `/api/ecs/services?envId=${currentEnvId}&sessionId=${sessionId}`
    );
    ecsServices = data.services || [];

    if (ecsServices.length === 0) {
      selectedEcsServices = [];
      updateEcsSummary();
      body.innerHTML = emptyRow(
        `No marketplace API service matched (${data.inspectedCount || 0} services inspected).`
      );
      return;
    }

    // Keep the previous selection across refreshes; default to everything
    // restartable, since web + worker + cron all read the secret at startup.
    const previous = selectedEcsServices.map(serviceKey);
    selectedEcsServices = ecsServices.filter((svc) =>
      previous.length > 0
        ? previous.includes(serviceKey(svc))
        : svc.desiredCount > 0
    );

    renderEcsServices();
  } catch (err) {
    ecsServices = [];
    selectedEcsServices = [];
    updateEcsSummary();
    body.innerHTML = emptyRow(
      `<span style="color: var(--danger);">Error: ${escapeHtml(err.message)}</span>`
    );
  }
};

window.openRestartModal = function () {
  openStep("step4");
  if (selectedEcsServices.length === 0) {
    setStatus(
      "ecsStatus",
      "Select at least one marketplace API service to restart.",
      "warning"
    );
    return;
  }

  const isProd = currentEnvName === "production";

  document.getElementById("restartCount").textContent =
    selectedEcsServices.length === 1
      ? `1 service (${selectedEcsServices[0].role})`
      : `${selectedEcsServices.length} services (${selectedEcsServices.map((s) => s.role).join(", ")})`;

  document.getElementById("restartServiceTable").innerHTML = selectedEcsServices
    .map(
      (s) =>
        `<tr style="border-bottom: 1px solid var(--border);">` +
          `<td style="padding: 6px 0; font-family: monospace; word-break: break-all;">${escapeHtml(s.serviceName)}</td>` +
          `<td style="padding: 6px 0;">${s.runningCount}/${s.desiredCount}</td>` +
          `<td style="padding: 6px 0; font-family: monospace; word-break: break-all;">${escapeHtml(s.taskDefinition || "unknown")}</td>` +
        `</tr>`
    )
    .join("");

  const badge = document.getElementById("restartEnvBadge");
  badge.textContent = currentEnvName;
  badge.className = `env-badge ${currentEnvName}`;

  document.getElementById("restartProdWarning").classList.toggle("hidden", !isProd);
  document.getElementById("restartProdAckLabel").classList.toggle("hidden", !isProd);
  document.getElementById("restartProdAck").checked = false;
  document.getElementById("restartConfirmInput").value = "";
  document.getElementById("btnConfirmRestart").disabled = true;

  document.getElementById("restartModal").classList.add("active");
  document.getElementById("restartConfirmInput").focus();
};

window.closeRestartModal = function () {
  document.getElementById("restartModal").classList.remove("active");
};

window.checkRestartInput = function () {
  const typed = document
    .getElementById("restartConfirmInput")
    .value.trim()
    .toLowerCase();
  const isProd = currentEnvName === "production";
  const acked = document.getElementById("restartProdAck").checked;
  document.getElementById("btnConfirmRestart").disabled =
    typed !== currentEnvName || (isProd && !acked);
};

window.confirmRestart = async function () {
  if (selectedEcsServices.length === 0) return;

  const targets = selectedEcsServices.map((s) => ({
    cluster: s.cluster,
    serviceName: s.serviceName,
  }));

  const btn = document.getElementById("btnConfirmRestart");
  btn.disabled = true;
  btn.textContent = "Restarting...";

  try {
    const result = await api("POST", "/api/ecs/restart", {
      envId: currentEnvId,
      sessionId,
      services: targets,
      confirmation: currentEnvName,
      acknowledgeProduction: currentEnvName === "production" ? true : undefined,
    });

    closeRestartModal();
    setStatus(
      "ecsStatus",
      `<span class="loading-spinner"></span>Restart triggered on ` +
        `<strong>${result.restarted.length} service(s)</strong>. Waiting for the rollout to complete...`,
      "warning"
    );
    startEcsDeploymentPolling(targets);
  } catch (err) {
    closeRestartModal();
    setStatus("ecsStatus", `Restart failed: ${err.message}`, "error");
  } finally {
    btn.textContent = "Restart";
    btn.disabled = false;
  }
};

function startEcsDeploymentPolling(targets) {
  stopEcsPolling();

  const startedAt = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  const query = targets.map((t) => `${t.cluster}/${t.serviceName}`).join(",");

  ecsPollTimer = setInterval(async () => {
    try {
      const report = await api(
        "GET",
        `/api/ecs/deployments?envId=${currentEnvId}&sessionId=${sessionId}` +
          `&services=${encodeURIComponent(query)}`
      );

      const detail = report.services
        .map(
          (s) =>
            `${escapeHtml(s.role === "other" ? s.serviceName : s.role)}: ` +
            `${s.runningCount}/${s.desiredCount} ` +
            `(${escapeHtml((s.primaryDeployment?.rolloutState || "IN_PROGRESS").toLowerCase())})`
        )
        .join(" &middot; ");

      if (report.anyFailed) {
        stopEcsPolling();
        const failed = report.services
          .filter((s) => s.primaryDeployment?.rolloutState === "FAILED")
          .map(
            (s) =>
              `${escapeHtml(s.serviceName)}: ` +
              escapeHtml(s.primaryDeployment?.rolloutStateReason || "no reason reported")
          )
          .join("<br>");
        setStatus("ecsStatus", `Deployment FAILED<br>${failed}`, "error");
        loadEcsServices();
        return;
      }

      if (report.allStable) {
        stopEcsPolling();
        setStatus(
          "ecsStatus",
          `Restart complete — all ${report.services.length} service(s) are running with the new secret.<br>` +
            `<small>${detail}</small>`,
          "success"
        );
        markStepDone(4);
        loadEcsServices();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        stopEcsPolling();
        setStatus(
          "ecsStatus",
          `Still deploying after 15 minutes — check the AWS console.<br><small>${detail}</small>`,
          "warning"
        );
        return;
      }

      setStatus(
        "ecsStatus",
        `<span class="loading-spinner"></span>Deploying...<br><small>${detail}</small>`,
        "warning"
      );
    } catch (err) {
      stopEcsPolling();
      setStatus("ecsStatus", `Lost track of the deployment: ${err.message}`, "error");
    }
  }, 10000);
}
// ── JSON Diff Generator ────────────────────────────────────────────────
function generateDiff(oldObj, newObj) {
  const oldLines = JSON.stringify(oldObj, null, 2).split("\n");
  const newLines = JSON.stringify(newObj, null, 2).split("\n");

  // Simple line-based diff using LCS
  const lcs = computeLCS(oldLines, newLines);
  const result = [];
  let oi = 0,
    ni = 0,
    li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      result.push(`<div class="diff-line diff-context">  ${escapeHtml(oldLines[oi])}</div>`);
      oi++;
      ni++;
      li++;
    } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
      result.push(`<div class="diff-line diff-add">+ ${escapeHtml(newLines[ni])}</div>`);
      ni++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      result.push(`<div class="diff-line diff-remove">- ${escapeHtml(oldLines[oi])}</div>`);
      oi++;
    }
  }

  if (result.every((r) => r.includes("diff-context"))) {
    return '<div class="status info">No differences detected.</div>';
  }

  return result.join("");
}

function computeLCS(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Init ───────────────────────────────────────────────────────────────
async function init() {
  applyMode();
  await loadProfiles();
  await restoreSession();
}

init();
