const state = {
  config: { machines: [] },
  tunnels: [],
  dashboardUrls: {},
  tunnelMessages: {},
  busyActions: {},
  editingMachineId: null,
  autoTunnelName: "",
  lastRefreshAt: null,
  refreshTimer: null,
  countdownTimer: null,
};

const AUTO_REFRESH_MS = 30 * 60 * 1000;
const COUNTDOWN_SECONDS = 20;

const elements = {
  discoverBtn: document.querySelector("#discoverBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  machineCount: document.querySelector("#machineCount"),
  tunnelCount: document.querySelector("#tunnelCount"),
  versionBadge: document.querySelector("#versionBadge"),
  notice: document.querySelector("#notice"),
  machineList: document.querySelector("#machineList"),
  tunnelList: document.querySelector("#tunnelList"),
  settingsForm: document.querySelector("#settingsForm"),
  machineForm: document.querySelector("#machineForm"),
  machineFormTitle: document.querySelector("#machineFormTitle"),
  machineFormHint: document.querySelector("#machineFormHint"),
  saveMachineBtn: document.querySelector("#saveMachineBtn"),
  cancelEditMachineBtn: document.querySelector("#cancelEditMachineBtn"),
  tunnelForm: document.querySelector("#tunnelForm"),
  machineSelect: document.querySelector("#machineSelect"),
  tunnelSubmit: document.querySelector("#tunnelForm button[type='submit']"),
  defaultSshUser: document.querySelector("#defaultSshUser"),
  defaultRemoteHost: document.querySelector("#defaultRemoteHost"),
  defaultRemotePort: document.querySelector("#defaultRemotePort"),
};

function setNotice(message, tone = "neutral") {
  elements.notice.textContent = message;
  elements.notice.dataset.tone = tone;
}

function formatRefreshTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "Request failed");
  return payload;
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

function setTunnelMessage(tunnelId, message, tone = "neutral") {
  state.tunnelMessages[tunnelId] = { message, tone };
  renderTunnels();
}

function setBusy(actionId, busy) {
  if (busy) {
    state.busyActions[actionId] = true;
  } else {
    delete state.busyActions[actionId];
  }
  renderTunnels();
}

function isLocalMachine(machine) {
  const values = [machine?.hostname, machine?.label, machine?.tailscaleIp].map((value) =>
    String(value || "").toLowerCase(),
  );
  return values.includes("localhost") || values.includes("127.0.0.1") || values.includes("::1");
}

function selectedMachine() {
  return (state.config.machines || []).find((machine) => machine.id === elements.machineSelect.value);
}

function currentAlias(machine) {
  return machine?.label || machine?.hostname || "";
}

function updateTunnelFormMode({ forceName = false } = {}) {
  const machine = selectedMachine();
  const local = isLocalMachine(machine);
  const { localPort, remoteHost, remotePort } = elements.tunnelForm.elements;
  const nameInput = elements.tunnelForm.elements.name;
  const alias = currentAlias(machine);

  if (forceName || !nameInput.value) {
    nameInput.value = alias;
    state.autoTunnelName = alias;
  }

  localPort.disabled = local;
  remoteHost.disabled = local;
  remotePort.disabled = local;
  elements.tunnelSubmit.textContent = local ? "Use Local Dashboard" : "Start Tunnel";

  if (local) {
    localPort.placeholder = "not needed";
    remoteHost.value = "127.0.0.1";
    remotePort.placeholder = "local gateway";
  } else {
    localPort.placeholder = "";
    remotePort.placeholder = "";
  }
}

function renderMachines() {
  const machines = state.config.machines || [];
  const selectedMachineId = elements.machineSelect.value;
  const runningTunnelsByMachine = new Map(
    (state.tunnels || [])
      .filter((tunnel) => tunnel.status === "running")
      .map((tunnel) => [tunnel.machineId, tunnel]),
  );
  elements.machineCount.textContent = machines.length;
  elements.machineList.classList.toggle("empty-list", machines.length === 0);
  elements.machineList.innerHTML =
    machines
      .map(
        (machine) => {
          const dashboardTunnel = runningTunnelsByMachine.get(machine.id);
          return `
          <article class="item">
            <div>
              <h3>${escapeHtml(machine.label)}</h3>
              <p>${escapeHtml(machine.hostname)} · ${escapeHtml(machine.role)} · Alias: ${escapeHtml(
                machine.label,
              )}</p>
              <code>${escapeHtml(machine.sshUser)}@${escapeHtml(machine.tailscaleIp)}</code>
            </div>
            <div class="item-actions">
              ${
                dashboardTunnel
                  ? `<button class="ghost" data-open-dashboard="${escapeHtml(
                      dashboardTunnel.id,
                    )}" type="button">Dashboard</button>`
                  : ""
              }
              <button class="ghost" data-vnc-machine="${escapeHtml(machine.id)}" type="button">VNC</button>
              <button class="ghost" data-edit-machine="${escapeHtml(machine.id)}" type="button">Edit</button>
              <button class="ghost danger" data-delete-machine="${escapeHtml(machine.id)}" type="button">Remove</button>
            </div>
          </article>
        `;
        },
      )
      .join("") || `<p class="empty-copy">No machines yet. Discover your Tailnet or add a Tailscale IP manually.</p>`;

  elements.machineSelect.innerHTML =
    machines
      .map(
        (machine) =>
          `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.label)} (${escapeHtml(
            machine.tailscaleIp,
          )})</option>`,
      )
      .join("") || `<option value="">No machines available</option>`;
  if (machines.some((machine) => machine.id === selectedMachineId)) {
    elements.machineSelect.value = selectedMachineId;
  }
  updateTunnelFormMode();
}

function renderSettings() {
  if (document.activeElement !== elements.defaultSshUser) {
    elements.defaultSshUser.value = state.config.sshUser || "";
  }
  if (document.activeElement !== elements.defaultRemoteHost) {
    elements.defaultRemoteHost.value = state.config.defaultRemoteHost || "127.0.0.1";
  }
  if (document.activeElement !== elements.defaultRemotePort) {
    elements.defaultRemotePort.value = state.config.defaultRemotePort || "";
  }

  const sshUserInput = elements.machineForm.elements.sshUser;
  if (!sshUserInput.value) sshUserInput.value = state.config.sshUser || "";

  const remoteHostInput = elements.tunnelForm.elements.remoteHost;
  const remotePortInput = elements.tunnelForm.elements.remotePort;
  if (!remoteHostInput.value) remoteHostInput.value = state.config.defaultRemoteHost || "127.0.0.1";
  if (!remotePortInput.value) remotePortInput.value = state.config.defaultRemotePort || "";
}

function setMachineFormMode(machine = null) {
  state.editingMachineId = machine?.id || null;
  elements.machineFormTitle.textContent = machine ? "Edit Machine" : "Add Machine";
  elements.machineFormHint.textContent = machine
    ? `Editing alias and connection details for ${machine.label}`
    : "Add your 3 Mac minis and 1 MacBook Pro here";
  elements.saveMachineBtn.textContent = machine ? "Update Machine" : "Save Machine";
  elements.cancelEditMachineBtn.hidden = !machine;

  if (machine) {
    elements.machineForm.elements.label.value = machine.label || "";
    elements.machineForm.elements.hostname.value = machine.hostname || "";
    elements.machineForm.elements.tailscaleIp.value = machine.tailscaleIp || "";
    elements.machineForm.elements.sshUser.value = machine.sshUser || state.config.sshUser || "";
    elements.machineForm.elements.role.value = machine.role || "mac";
  }
}

function resetMachineForm() {
  elements.machineForm.reset();
  setMachineFormMode(null);
  elements.machineForm.elements.sshUser.value = state.config.sshUser || "";
}

function renderTunnels() {
  const tunnels = state.tunnels || [];
  elements.tunnelCount.textContent = tunnels.filter((tunnel) => tunnel.status === "running").length;
  elements.tunnelList.classList.toggle("empty-list", tunnels.length === 0);
  elements.tunnelList.innerHTML =
    tunnels
      .map((tunnel) => {
        const dashboardUrl = state.dashboardUrls[tunnel.id];
        const tunnelMessage = state.tunnelMessages[tunnel.id];
        const isApproving = Boolean(state.busyActions[`approve:${tunnel.id}`]);
        const isPreparingDashboard = Boolean(state.busyActions[`dashboard:${tunnel.id}`]);
        return `
          <article class="item tunnel">
            <div>
              <div class="item-title-row">
                <h3>${escapeHtml(tunnel.name)}</h3>
                <span class="pill" data-status="${escapeHtml(tunnel.status)}">${escapeHtml(tunnel.status)}</span>
              </div>
              <p>${
                tunnel.kind === "local"
                  ? `${escapeHtml(tunnel.machineLabel)} · local gateway`
                  : `${escapeHtml(tunnel.machineLabel)} · ${escapeHtml(tunnel.remoteHost)}:${escapeHtml(
                      tunnel.remotePort,
                    )}`
              }</p>
              <p>${
                tunnel.kind === "local"
                  ? `Local dashboard: <code>localhost:${escapeHtml(tunnel.localPort)}</code>`
                  : `Raw tunnel: <code>localhost:${escapeHtml(tunnel.localPort)}</code>`
              }</p>
              ${tunnel.error ? `<small>${escapeHtml(tunnel.error)}</small>` : ""}
              ${
                dashboardUrl
                  ? `<div class="token-url">
                      <label>
                        Tokenized Dashboard URL
                        <input readonly value="${escapeHtml(dashboardUrl)}" />
                      </label>
                    </div>`
                  : ""
              }
              ${
                tunnelMessage
                  ? `<div class="inline-message" data-tone="${escapeHtml(tunnelMessage.tone)}">${escapeHtml(
                      tunnelMessage.message,
                    )}</div>`
                  : ""
              }
            </div>
            <div class="item-actions">
              ${
                tunnel.status === "running"
                  ? `<button class="ghost" data-open-dashboard="${escapeHtml(
                      tunnel.id,
                    )}" type="button" ${isPreparingDashboard ? "disabled" : ""}>${
                      isPreparingDashboard ? "Preparing..." : "Open Dashboard"
                    }</button>`
                  : ""
              }
              ${
                dashboardUrl
                  ? `<button class="ghost" data-open-tokenized-url="${escapeHtml(
                      tunnel.id,
                    )}" type="button">Open Tokenized URL</button>
                    <button class="ghost" data-approve-device="${escapeHtml(
                      tunnel.id,
                    )}" type="button" ${isApproving ? "disabled" : ""}>${
                      isApproving ? "Approving..." : "Approve Latest Device"
                    }</button>
                    <button class="ghost" data-copy-dashboard-url="${escapeHtml(tunnel.id)}" type="button">Copy URL</button>`
                  : ""
              }
              <button class="ghost danger" data-stop-tunnel="${escapeHtml(tunnel.id)}" type="button">Stop</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty-copy">No port forwards are running.</p>`;
}

function render() {
  renderSettings();
  renderMachines();
  renderTunnels();
}

async function loadState() {
  const payload = await api("/api/state");
  state.config = payload.config;
  state.tunnels = payload.tunnels;
  if (payload.version?.label) elements.versionBadge.textContent = payload.version.label;
  render();
}

async function refreshState(reason = "manual") {
  await loadState();
  state.lastRefreshAt = new Date();
  setNotice(`List refreshed at ${formatRefreshTime(state.lastRefreshAt)}`, "success");
  scheduleAutoRefresh();
  if (reason === "auto") {
    setNotice(`List refreshed at ${formatRefreshTime(state.lastRefreshAt)}`, "success");
  }
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  if (state.countdownTimer) clearInterval(state.countdownTimer);

  state.refreshTimer = setTimeout(() => {
    refreshState("auto").catch((error) => {
      setNotice(error.message, "warning");
      scheduleAutoRefresh();
    });
  }, AUTO_REFRESH_MS);

  const countdownStartsIn = AUTO_REFRESH_MS - COUNTDOWN_SECONDS * 1000;
  state.countdownTimer = setTimeout(() => {
    let remaining = COUNTDOWN_SECONDS;
    setNotice(`Auto-refresh in ${remaining}s`);
    const interval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(interval);
        return;
      }
      setNotice(`Auto-refresh in ${remaining}s`);
    }, 1000);
    state.countdownTimer = interval;
  }, countdownStartsIn);
}

elements.refreshBtn.addEventListener("click", async () => {
  try {
    setNotice("Refreshing...");
    await refreshState("manual");
  } catch (error) {
    setNotice(error.message, "warning");
  }
});

elements.machineSelect.addEventListener("change", () => updateTunnelFormMode({ forceName: true }));

elements.cancelEditMachineBtn.addEventListener("click", resetMachineForm);

elements.discoverBtn.addEventListener("click", async () => {
  setNotice("Scanning Tailscale...");
  try {
    const payload = await api("/api/discover", { method: "POST", body: "{}" });
    await loadState();
    setNotice(`Found ${payload.machines.length}; imported ${payload.imported}`, "success");
  } catch (error) {
    setNotice(error.message, "warning");
  }
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = formPayload(event.currentTarget);
    payload.applyToMachines = event.currentTarget.elements.applyToMachines.checked;
    await api("/api/config", { method: "PATCH", body: JSON.stringify(payload) });
    await loadState();
    setNotice("Defaults saved", "success");
  } catch (error) {
    setNotice(error.message, "warning");
  }
});

elements.machineForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = formPayload(event.currentTarget);
    const wasEditing = Boolean(state.editingMachineId);
    if (state.editingMachineId) payload.id = state.editingMachineId;
    await api("/api/machines", { method: "POST", body: JSON.stringify(payload) });
    resetMachineForm();
    await loadState();
    setNotice(wasEditing ? "Machine updated" : "Machine saved", "success");
  } catch (error) {
    setNotice(error.message, "warning");
  }
});

elements.tunnelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/tunnels", { method: "POST", body: JSON.stringify(formPayload(event.currentTarget)) });
    await loadState();
    setNotice("Tunnel started", "success");
  } catch (error) {
    setNotice(error.message, "warning");
  }
});

document.addEventListener("click", async (event) => {
  const deleteMachineId = event.target.dataset.deleteMachine;
  const editMachineId = event.target.dataset.editMachine;
  const vncMachineId = event.target.dataset.vncMachine;
  const stopTunnelId = event.target.dataset.stopTunnel;
  const openDashboardId = event.target.dataset.openDashboard;
  const openTokenizedUrlId = event.target.dataset.openTokenizedUrl;
  const copyDashboardUrlId = event.target.dataset.copyDashboardUrl;
  const approveDeviceId = event.target.dataset.approveDevice;

  if (deleteMachineId) {
    await api(`/api/machines/${deleteMachineId}`, { method: "DELETE" });
    await loadState();
    setNotice("Machine removed");
  }

  if (editMachineId) {
    const machine = (state.config.machines || []).find((item) => item.id === editMachineId);
    if (machine) {
      setMachineFormMode(machine);
      elements.machineForm.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  if (vncMachineId) {
    const machine = (state.config.machines || []).find((item) => item.id === vncMachineId);
    if (machine) {
      window.location.href = `vnc://${encodeURIComponent(machine.sshUser || state.config.sshUser)}@${machine.tailscaleIp}`;
    }
  }

  if (stopTunnelId) {
    await api(`/api/tunnels/${stopTunnelId}`, { method: "DELETE" });
    await loadState();
    setNotice("Tunnel stopped");
  }

  if (openDashboardId) {
    const dashboardWindow = window.open("about:blank", "_blank");
    try {
      setBusy(`dashboard:${openDashboardId}`, true);
      setTunnelMessage(openDashboardId, "Preparing tokenized dashboard URL...");
      setNotice("Preparing dashboard auth...");
      const payload = await api(`/api/tunnels/${openDashboardId}/dashboard`, { method: "POST", body: "{}" });
      state.dashboardUrls[openDashboardId] = payload.url;
      setTunnelMessage(openDashboardId, "Tokenized dashboard URL is ready.", "success");
      if (dashboardWindow) {
        dashboardWindow.location.href = payload.url;
      }
      setNotice("Tokenized dashboard URL ready", "success");
    } catch (error) {
      if (dashboardWindow) dashboardWindow.close();
      setTunnelMessage(openDashboardId, error.message, "warning");
      setNotice(error.message, "warning");
    } finally {
      setBusy(`dashboard:${openDashboardId}`, false);
    }
  }

  if (openTokenizedUrlId) {
    const url = state.dashboardUrls[openTokenizedUrlId];
    if (url) window.open(url, "_blank");
  }

  if (copyDashboardUrlId) {
    const url = state.dashboardUrls[copyDashboardUrlId];
    if (url) {
      await navigator.clipboard.writeText(url);
      setNotice("Tokenized dashboard URL copied", "success");
    }
  }

  if (approveDeviceId) {
    try {
      setBusy(`approve:${approveDeviceId}`, true);
      setTunnelMessage(approveDeviceId, "Approving the latest device pairing request...");
      setNotice("Approving latest device request...");
      await api(`/api/tunnels/${approveDeviceId}/devices/approve-latest`, { method: "POST", body: "{}" });
      setTunnelMessage(approveDeviceId, "Latest device request approved. Reopen the tokenized URL.", "success");
      setNotice("Latest device request approved. Reopen the tokenized URL.", "success");
    } catch (error) {
      setTunnelMessage(approveDeviceId, error.message, "warning");
      setNotice(error.message, "warning");
    } finally {
      setBusy(`approve:${approveDeviceId}`, false);
    }
  }
});

refreshState("initial").catch((error) => {
  setNotice(error.message, "warning");
  scheduleAutoRefresh();
});
