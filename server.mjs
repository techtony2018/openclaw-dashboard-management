import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const dataDir = join(rootDir, "data");
const configPath = join(dataDir, "config.json");
const knownHostsPath = join(dataDir, "known_hosts");
const localOpenClawConfigPath = join(homedir(), ".openclaw", "openclaw.json");
const versionPath = join(rootDir, "version.json");
const port = Number(process.env.PORT || 4177);

const tunnels = new Map();

const defaultConfig = {
  sshUser: "",
  defaultRemoteHost: "127.0.0.1",
  defaultRemotePort: null,
  machines: [],
  savedTunnels: [],
};

function ensureConfig() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(configPath)) saveConfig(defaultConfig);
  if (!existsSync(knownHostsPath)) writeFileSync(knownHostsPath, "");
}

function loadConfig() {
  ensureConfig();
  return { ...defaultConfig, ...JSON.parse(readFileSync(configPath, "utf8")) };
}

function loadVersion() {
  const version = JSON.parse(readFileSync(versionPath, "utf8"));
  return {
    ...version,
    label: `v${version.major}.${String(version.build).padStart(2, "0")}`,
  };
}

function saveConfig(config) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function saveTunnelSpec(tunnel) {
  const config = loadConfig();
  const spec = {
    id: tunnel.id,
    kind: tunnel.kind || "ssh",
    name: tunnel.name,
    machineId: tunnel.machineId,
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort,
  };
  config.savedTunnels = [
    ...(config.savedTunnels || []).filter(
      (item) => item.id !== spec.id && !(item.machineId === spec.machineId && item.localPort === spec.localPort),
    ),
    spec,
  ];
  saveConfig(config);
}

function removeTunnelSpec(id) {
  const config = loadConfig();
  config.savedTunnels = (config.savedTunnels || []).filter((item) => item.id !== id);
  saveConfig(config);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function publicTunnelView() {
  return [...tunnels.values()].map(({ process: _process, ...tunnel }) => tunnel);
}

function isLocalMachine(machine) {
  const values = [machine.hostname, machine.label, machine.tailscaleIp].map((value) =>
    String(value || "").toLowerCase(),
  );
  return values.includes("localhost") || values.includes("127.0.0.1") || values.includes("::1");
}

function runCommand(command, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code, timedOut });
    });
  });
}

function portReachable(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 700 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function findAvailableLocalPort(requestedPort) {
  for (let port = requestedPort; port <= 65535; port += 1) {
    const usedByTunnel = [...tunnels.values()].some(
      (tunnel) => tunnel.localPort === port && !["failed", "stopped"].includes(tunnel.status),
    );
    if (usedByTunnel) continue;
    if (await portReachable(port)) continue;
    return port;
  }
  throw new Error(`No available local port found at or above ${requestedPort}`);
}

function runSshCommand(machine, command, timeoutMs = 12000) {
  const config = loadConfig();
  const sshTarget = `${machine.sshUser || config.sshUser}@${machine.tailscaleIp}`;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    sshTarget,
    command,
  ];
  return runCommand("ssh", args, timeoutMs);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function normalizeMachine(input) {
  const config = loadConfig();
  const hostname = String(input.hostname || input.name || "").trim();
  const tailscaleIp = String(input.tailscaleIp || input.ip || "").trim();
  const sshUser = String(input.sshUser || config.sshUser).trim();
  if (!hostname) throw new Error("Machine hostname is required");
  if (!tailscaleIp) throw new Error("Machine Tailscale IP is required");
  if (!sshUser) throw new Error("Machine SSH user is required");
  return {
    id: input.id || randomUUID(),
    hostname,
    label: String(input.label || hostname).trim(),
    role: String(input.role || (/mac\s*mini/i.test(hostname) ? "mac mini" : "mac")).trim(),
    tailscaleIp,
    sshUser,
    services: Array.isArray(input.services) ? input.services : [],
    discoveredAt: input.discoveredAt || null,
    updatedAt: new Date().toISOString(),
  };
}

function readOpenClawConfig(path = localOpenClawConfigPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeOpenClawConfig(config, path = localOpenClawConfigPath) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function getLocalDashboardAuth(localPort = null) {
  const openClawConfig = readOpenClawConfig();
  const gateway = openClawConfig.gateway || {};
  const auth = gateway.auth || {};
  const gatewayPort = Number(gateway.port || localPort || 0);
  if (!gatewayPort) throw new Error("Local OpenClaw gateway port is missing");
  const origins = gateway.controlUi?.allowedOrigins || [];
  const wanted = [`http://localhost:${gatewayPort}`, `http://127.0.0.1:${gatewayPort}`];

  gateway.controlUi = {
    ...(gateway.controlUi || {}),
    allowedOrigins: [...new Set([...origins, ...wanted])],
  };
  openClawConfig.gateway = gateway;
  writeOpenClawConfig(openClawConfig);

  if (!auth.token) throw new Error("Local OpenClaw gateway token is missing");

  return {
    url: `http://127.0.0.1:${gatewayPort}/#token=${auth.token}`,
    port: gatewayPort,
    authMode: auth.mode,
    allowedOrigins: gateway.controlUi.allowedOrigins,
  };
}

function updateConfig(input) {
  const config = loadConfig();
  const sshUser = String(input.sshUser || "").trim();
  const defaultRemoteHost = String(input.defaultRemoteHost || config.defaultRemoteHost).trim();
  const defaultRemotePort = Number(input.defaultRemotePort || config.defaultRemotePort);

  if (!sshUser) throw new Error("Default SSH user is required");
  if (!defaultRemoteHost) throw new Error("Default remote host is required");
  if (!defaultRemotePort || defaultRemotePort < 1 || defaultRemotePort > 65535) {
    throw new Error("Invalid default remote port");
  }

  config.sshUser = sshUser;
  config.defaultRemoteHost = defaultRemoteHost;
  config.defaultRemotePort = defaultRemotePort;

  if (input.applyToMachines) {
    config.machines = config.machines.map((machine) => ({
      ...machine,
      sshUser,
      updatedAt: new Date().toISOString(),
    }));
  }

  saveConfig(config);
  return config;
}

async function discoverTailscaleMachines() {
  const result = await runCommand("tailscale", ["status", "--json"]);
  if (!result.ok) {
    return {
      ok: false,
      machines: [],
      error:
        "Cannot run `tailscale status --json`. Install Tailscale CLI or add machines manually.",
      details: result.stderr || result.stdout,
    };
  }

  const status = JSON.parse(result.stdout);
  const selfHost = status.Self?.HostName;
  const peers = Object.values(status.Peer || {});
  const machines = peers
    .filter((peer) => peer.Online || peer.TailscaleIPs?.length)
    .map((peer) => ({
      hostname: peer.HostName || peer.DNSName || peer.ID,
      label: peer.HostName || peer.DNSName || peer.ID,
      role: /macmini/i.test(peer.HostName || "") ? "mac mini" : "mac",
      tailscaleIp: peer.TailscaleIPs?.[0] || "",
      online: Boolean(peer.Online),
      os: peer.OS || "unknown",
      discoveredAt: new Date().toISOString(),
    }));

  return { ok: true, selfHost, machines };
}

async function mergeDiscovery() {
  const discovery = await discoverTailscaleMachines();
  if (!discovery.ok) return discovery;

  const config = loadConfig();
  const existingByIp = new Map(config.machines.map((machine) => [machine.tailscaleIp, machine]));
  const merged = [...config.machines];

  for (const machine of discovery.machines) {
    if (!machine.tailscaleIp || existingByIp.has(machine.tailscaleIp)) continue;
    merged.push(normalizeMachine({ ...machine, sshUser: config.sshUser }));
  }

  config.machines = merged;
  saveConfig(config);
  return { ...discovery, imported: merged.length - existingByIp.size };
}

async function startTunnel(input) {
  const config = loadConfig();
  const machine = config.machines.find((item) => item.id === input.machineId);
  if (!machine) throw new Error("Machine not found");

  if (isLocalMachine(machine)) {
    const dashboard = getLocalDashboardAuth(Number(input.remotePort || 0) || null);
    const existing = [...tunnels.values()].find(
      (tunnel) => tunnel.kind === "local" && tunnel.machineId === machine.id && tunnel.status === "running",
    );
    if (existing) return existing;

    const id = input.id || randomUUID();
    const tunnel = {
      id,
      kind: "local",
      name: String(input.name || machine.label || `${machine.hostname} local dashboard`).trim(),
      machineId: machine.id,
      machineLabel: machine.label,
      tailscaleIp: machine.tailscaleIp,
      localPort: dashboard.port,
      remoteHost: "127.0.0.1",
      remotePort: dashboard.port,
      status: "running",
      error: "",
      startedAt: new Date().toISOString(),
    };
    tunnels.set(id, tunnel);
    saveTunnelSpec(tunnel);
    return tunnel;
  }

  const remoteHost = String(input.remoteHost || config.defaultRemoteHost).trim();
  const remotePort = Number(input.remotePort || config.defaultRemotePort);
  let localPort = Number(input.localPort || 0);
  if (!remotePort || remotePort < 1 || remotePort > 65535) throw new Error("Invalid remote port");
  if (!localPort || localPort < 1 || localPort > 65535) throw new Error("Invalid local port");
  localPort = await findAvailableLocalPort(localPort);

  const id = input.id || randomUUID();
  const sshTarget = `${input.sshUser || machine.sshUser || config.sshUser}@${machine.tailscaleIp}`;
  const args = [
    "-N",
    "-L",
    `${localPort}:${remoteHost}:${remotePort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    sshTarget,
  ];

  const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  const tunnel = {
    id,
    name: String(input.name || machine.label || `${machine.hostname} :${remotePort}`).trim(),
    machineId: machine.id,
    machineLabel: machine.label,
    tailscaleIp: machine.tailscaleIp,
    localPort,
    remoteHost,
    remotePort,
    status: "starting",
    error: "",
    startedAt: new Date().toISOString(),
    process: child,
  };
  tunnels.set(id, tunnel);
  saveTunnelSpec(tunnel);

  child.stderr.on("data", (chunk) => {
    tunnel.error = String(chunk).trim();
  });
  child.on("spawn", () => {
    setTimeout(() => {
      if (tunnels.has(id) && tunnel.status === "starting") tunnel.status = "running";
    }, 900);
  });
  child.on("exit", (code, signal) => {
    tunnel.status = code === 0 || signal === "SIGTERM" ? "stopped" : "failed";
    tunnel.stoppedAt = new Date().toISOString();
    tunnel.error ||= signal ? `ssh exited with ${signal}` : `ssh exited with code ${code}`;
  });

  return tunnel;
}

function stopTunnel(id) {
  const tunnel = tunnels.get(id);
  if (!tunnel) throw new Error("Tunnel not found");
  if (tunnel.process) tunnel.process.kill("SIGTERM");
  tunnel.status = "stopped";
  tunnel.stoppedAt = new Date().toISOString();
  tunnels.delete(id);
  removeTunnelSpec(id);
}

async function createDashboardUrl(tunnelId) {
  const { dashboardUrl, tunnel } = await getDashboardAuth(tunnelId);
  return {
    url: dashboardUrl.toString(),
    tunnel: publicTunnelView().find((item) => item.id === tunnel.id),
  };
}

async function getDashboardAuth(tunnelId) {
  const tunnel = tunnels.get(tunnelId);
  if (!tunnel) throw new Error("Tunnel not found");
  if (tunnel.status !== "running") throw new Error("Tunnel is not running");

  const config = loadConfig();
  const machine = config.machines.find((item) => item.id === tunnel.machineId);
  if (!machine) throw new Error("Machine not found");

  if (tunnel.kind === "local" || isLocalMachine(machine)) {
    const dashboard = getLocalDashboardAuth(tunnel.localPort);
    const dashboardUrl = new URL(dashboard.url);
    dashboardUrl.hostname = "localhost";
    return { dashboard, dashboardUrl, tunnel, machine };
  }

  const localOrigins = JSON.stringify([
    `http://localhost:${tunnel.localPort}`,
    `http://127.0.0.1:${tunnel.localPort}`,
  ]);
  const python = [
    "import json,pathlib",
    "p=pathlib.Path.home()/\".openclaw/openclaw.json\"",
    "cfg=json.loads(p.read_text())",
    "gw=cfg.get(\"gateway\",{})",
    "ui=gw.setdefault(\"controlUi\",{})",
    "origins=ui.setdefault(\"allowedOrigins\",[])",
    `wanted=${localOrigins}`,
    "ui[\"allowedOrigins\"]=list(dict.fromkeys(origins+wanted))",
    "p.write_text(json.dumps(cfg,indent=2)+\"\\n\")",
    "auth=gw.get(\"auth\",{})",
    "token=auth.get(\"token\",\"\")",
    "port=gw.get(\"port\")",
    "assert port,\"Remote gateway port is missing\"",
    "print(json.dumps({\"url\":f\"http://127.0.0.1:{port}/#token={token}\",\"port\":port,\"authMode\":auth.get(\"mode\"),\"allowedOrigins\":ui[\"allowedOrigins\"]}))",
  ].join("; ");
  const command = `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; python3 -c '${python}'`;
  const result = await runSshCommand(machine, command, 20000);
  const output = `${result.stdout}\n${result.stderr}`;
  let dashboard;
  try {
    dashboard = JSON.parse(result.stdout.trim());
  } catch {
    dashboard = null;
  }

  if (!result.ok || !dashboard?.url || !dashboard.url.includes("#token=")) {
    throw new Error(
      `Could not get dashboard auth URL from remote OpenClaw config. ${output.trim() || "No output"}`,
    );
  }

  const dashboardUrl = new URL(dashboard.url);
  dashboardUrl.hostname = "localhost";
  dashboardUrl.port = String(tunnel.localPort);

  return { dashboard, dashboardUrl, tunnel, machine };
}

async function approveLatestDevice(tunnelId) {
  const { tunnel, machine } = await getDashboardAuth(tunnelId);
  const listResult = await runDeviceCommand(tunnel, machine, ["list", "--json", "--timeout", "10000"]);
  const listOutput = `${listResult.stdout}\n${listResult.stderr}`.trim();
  let devices = null;
  try {
    devices = JSON.parse(listResult.stdout);
  } catch {
    // Fall through to the error below.
  }

  if (!listResult.ok || !devices) {
    throw new Error(
      listOutput ||
        (listResult.timedOut
          ? "OpenClaw CLI timed out while listing device pairing requests"
          : "Could not list device pairing requests"),
    );
  }

  const pending = Array.isArray(devices.pending) ? devices.pending : [];
  if (pending.length === 0) throw new Error("No pending device pairing requests to approve");

  const latest = pending.reduce((best, item) => ((item.ts || 0) > (best.ts || 0) ? item : best), pending[0]);
  if (!latest.requestId) throw new Error("Latest device pairing request is missing a request id");

  const result = await runDeviceCommand(tunnel, machine, [
    "approve",
    latest.requestId,
    "--json",
    "--timeout",
    "10000",
  ]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Keep the raw output below for diagnostics.
  }

  if (!result.ok) {
    throw new Error(
      output ||
        (result.timedOut
          ? "OpenClaw CLI timed out while approving the latest device request"
          : "Could not approve the latest device pairing request"),
    );
  }

  return {
    ok: true,
    result: parsed || output,
    tunnel: publicTunnelView().find((item) => item.id === tunnel.id),
  };
}

async function listDevices(tunnelId) {
  const { tunnel, machine } = await getDashboardAuth(tunnelId);
  const result = await runDeviceCommand(tunnel, machine, ["list", "--json", "--timeout", "10000"]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Keep the raw output below for diagnostics.
  }

  if (!result.ok) {
    throw new Error(
      output ||
        (result.timedOut
          ? "OpenClaw CLI timed out while listing device pairing requests"
          : "Could not list device pairing requests"),
    );
  }

  return {
    ok: true,
    result: parsed || output,
    tunnel: publicTunnelView().find((item) => item.id === tunnel.id),
  };
}

function runDeviceCommand(tunnel, machine, args) {
  if (tunnel.kind === "local" || isLocalMachine(machine)) {
    return runCommand("openclaw", ["devices", ...args], 18000);
  }

  const command = [
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "openclaw",
    "devices",
    ...args.map((arg) => shellQuote(arg)),
  ].join(" ");
  return runSshCommand(machine, command, 18000);
}

async function restoreSavedTunnels() {
  const config = loadConfig();
  for (const spec of config.savedTunnels || []) {
    if (tunnels.has(spec.id)) continue;
    try {
      const machine = config.machines.find((item) => item.id === spec.machineId);
      if (!machine) continue;

      if (spec.kind !== "local" && (await portReachable(spec.localPort))) {
        tunnels.set(spec.id, {
          ...spec,
          machineLabel: machine.label,
          tailscaleIp: machine.tailscaleIp,
          status: "running",
          error: "",
          reused: true,
          startedAt: new Date().toISOString(),
        });
        continue;
      }

      const restored = await startTunnel(spec);
      if (restored.id !== spec.id) {
        const tunnel = tunnels.get(restored.id);
        if (tunnel) {
          tunnels.delete(restored.id);
          tunnel.id = spec.id;
          tunnels.set(tunnel.id, tunnel);
        }
      }
    } catch (error) {
      const machine = config.machines.find((item) => item.id === spec.machineId);
      if (!machine) continue;
      tunnels.set(spec.id, {
        ...spec,
        machineLabel: machine.label,
        tailscaleIp: machine.tailscaleIp,
        status: "failed",
        error: error.message,
        startedAt: new Date().toISOString(),
      });
    }
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = safePath === "/" ? join(publicDir, "index.html") : join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const type =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    }[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(filePath));
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/state") {
      const config = loadConfig();
      return sendJson(res, 200, {
        config: { ...config, sshUser: config.sshUser },
        tunnels: publicTunnelView(),
        version: loadVersion(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/discover") {
      return sendJson(res, 200, await mergeDiscovery());
    }

    if (req.method === "PATCH" && url.pathname === "/api/config") {
      return sendJson(res, 200, { config: updateConfig(await readBody(req)) });
    }

    if (req.method === "POST" && url.pathname === "/api/machines") {
      const body = await readBody(req);
      const config = loadConfig();
      const machine = normalizeMachine(body);
      config.machines = [...config.machines.filter((item) => item.id !== machine.id), machine];
      saveConfig(config);
      return sendJson(res, 200, { machine });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/machines/")) {
      const id = url.pathname.split("/").pop();
      const config = loadConfig();
      config.machines = config.machines.filter((item) => item.id !== id);
      saveConfig(config);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/tunnels") {
      const tunnel = await startTunnel(await readBody(req));
      return sendJson(res, 200, { tunnel: publicTunnelView().find((item) => item.id === tunnel.id) });
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/tunnels\/[^/]+\/dashboard$/)) {
      const id = url.pathname.split("/").at(-2);
      return sendJson(res, 200, await createDashboardUrl(id));
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/tunnels\/[^/]+\/devices\/approve-latest$/)) {
      const id = url.pathname.split("/").at(-3);
      return sendJson(res, 200, await approveLatestDevice(id));
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/tunnels\/[^/]+\/devices$/)) {
      const id = url.pathname.split("/").at(-2);
      return sendJson(res, 200, await listDevices(id));
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/tunnels/")) {
      stopTunnel(url.pathname.split("/").pop());
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "API route not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
}).listen(port, "127.0.0.1", async () => {
  ensureConfig();
  await restoreSavedTunnels();
  console.log(`OpenClaw Management System running at http://localhost:${port}`);
});
