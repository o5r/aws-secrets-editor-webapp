import {
  JSONEditor,
} from "https://cdn.jsdelivr.net/npm/vanilla-jsoneditor@2/standalone.js";

// ── State ──────────────────────────────────────────────────────────────
let sessionId = null;
let currentProfileName = null;
let currentEnvId = null;
let currentEnvName = null;
let originalValue = null; // The value as loaded from AWS
let editor = null;
let versionViewerEditor = null;
let versionToRestore = null;
let pollTimer = null;

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

    // Load version history
    loadVersionHistory();
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
        document.getElementById("btnReview").disabled = !hasChanges;
        document.getElementById("editorStatus").textContent = hasChanges
          ? "Unsaved changes"
          : "No changes";
      },
    },
  });

  document.getElementById("btnReview").disabled = true;
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

  const diffBadge = document.getElementById("diffEnvBadge");
  diffBadge.textContent = currentEnvName;
  diffBadge.className = `env-badge ${currentEnvName}`;

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
    document.getElementById("btnReview").disabled = true;
    document.getElementById("editorStatus").textContent = "No changes";

    setStatus(
      "editorMainStatus",
      `Secret updated successfully! New version: ${result.versionId?.substring(0, 8)}...`,
      "success"
    );

    // Refresh version history
    loadVersionHistory();
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

  try {
    const data = await api("GET", `/api/secret/versions?envId=${currentEnvId}&sessionId=${sessionId}`);
    list.innerHTML = "";

    if (data.versions.length === 0) {
      list.innerHTML = '<li style="color: var(--text-muted); font-size: 0.8rem; padding: 8px;">No versions found</li>';
      return;
    }

    for (const v of data.versions) {
      const li = document.createElement("li");
      li.className = "version-item";
      li.onclick = () => viewVersion(v.versionId);

      const date = v.createdDate ? new Date(v.createdDate).toLocaleString() : "Unknown date";
      const stages = (v.versionStages || [])
        .map((s) => {
          const cls = s === "AWSCURRENT" ? "current" : s === "AWSPREVIOUS" ? "previous" : "";
          return `<span class="version-stage ${cls}">${s}</span>`;
        })
        .join(" ");

      li.innerHTML =
        `<div class="version-date">${date}</div>` +
        `<div>${stages}</div>` +
        `<div class="version-id">${v.versionId}</div>`;

      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li style="color: var(--danger); font-size: 0.8rem; padding: 8px;">Error: ${err.message}</li>`;
  }
};

async function viewVersion(versionId) {
  try {
    const data = await api(
      "GET",
      `/api/secret/version/${encodeURIComponent(versionId)}?envId=${currentEnvId}&sessionId=${sessionId}`
    );

    versionToRestore = data.value;

    document.getElementById("versionModalId").textContent = versionId;

    const container = document.getElementById("versionJsonViewer");
    container.innerHTML = "";

    if (versionViewerEditor) {
      versionViewerEditor.destroy();
      versionViewerEditor = null;
    }

    versionViewerEditor = new JSONEditor({
      target: container,
      props: {
        content: { json: data.value },
        mode: "tree",
        mainMenuBar: false,
        readOnly: true,
      },
    });

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
  document.getElementById("btnReview").disabled = false;
  document.getElementById("editorStatus").textContent = "Unsaved changes (restored from version)";
  setStatus("editorMainStatus", "Version content loaded into editor. Review and save when ready.", "warning");
};

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
loadProfiles();
