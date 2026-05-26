# OpenClaw Management System

A local Web management console for a MacBook that manages multiple Macs through Tailscale IPs and SSH local port forwarding.

## Features

- Discovers machines in the same Tailnet with `tailscale status --json`
- Supports manually adding 3 Mac minis and 1 MacBook Pro
- Starts SSH local port forwards for remote services
- Lets you set the OpenClaw Gateway remote port locally
- Lets you edit machine aliases and uses each alias as the default tunnel name
- Opens VNC URLs for machines, for example `vnc://SSH_USER@100.x.y.z`
- Refreshes the machine/tunnel state every 30 minutes, with a 20 second visible countdown and a manual refresh button
- Saves tunnel definitions and restores or reuses them after the management server restarts when possible
- Keeps service tokens out of the UI: users open a local `localhost` port, while remote authentication stays on the target machine or service
- Opens dashboards by simulating `openclaw dashboard --no-open --yes` on the target Mac, then rewriting the token-authenticated URL to the local tunnel
- Uses an app-local SSH `known_hosts` file at `data/known_hosts` to avoid conflicts with your global SSH host key records
- Runs with Node.js 20+ and no third-party dependencies

## Start

```bash
npm start
```

Open:

```text
http://localhost:4177
```

## Requirements

Each managed Mac needs:

1. Membership in the same Tailscale Tailnet
2. SSH login enabled
3. SSH key login configured, so users do not handle passwords or tokens in the UI

Enable SSH on macOS:

```bash
sudo systemsetup -setremotelogin on
```

Verify SSH access:

```bash
ssh SSH_USER@100.x.y.z
```

## Configuration

The first launch creates:

```text
data/config.json
```

This runtime file is ignored by Git. Keep SSH usernames, Tailnet addresses, ports, saved tunnels, and other installation-specific settings there rather than committing them.

Use this template as a reference:

```text
data/config.example.json
```

## Port Forwarding Model

If OpenClaw Gateway is running on `macmini-01` at `127.0.0.1:GATEWAY_PORT`, create this tunnel in the console:

- Machine: `macmini-01`
- Local port: `LOCAL_PORT`
- Remote host: `127.0.0.1`
- Remote port: `GATEWAY_PORT`

The system runs the equivalent of:

```bash
ssh -N -L LOCAL_PORT:127.0.0.1:GATEWAY_PORT \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=data/known_hosts \
  SSH_USER@100.x.y.z
```

Users open:

```text
http://localhost:LOCAL_PORT
```

For the Control UI, click **Open Dashboard** instead of opening the raw tunnel URL. The management system creates a token-authenticated dashboard URL, shows the full `#token=...` URL in the tunnel card, copies/opens it on demand, and rewrites it to the equivalent local tunnel URL.

During dashboard preparation, the management system also adds the local tunnel origins, such as `http://localhost:LOCAL_PORT` and `http://127.0.0.1:LOCAL_PORT`, to the target Mac's `gateway.controlUi.allowedOrigins`. This keeps loopback-only gateways usable through SSH forwarding without asking users to edit remote OpenClaw config by hand.

When the selected machine is `localhost`, no SSH tunnel is created. The management system reads the local OpenClaw gateway config directly and opens its tokenized dashboard URL.

If the Control UI asks for one-time device pairing, return to the tunnel card and click **Approve Latest Device**. The management system lists pending device requests on the target Mac and approves the newest explicit request ID through SSH.

## Troubleshooting

### `Host key verification failed`

The app now uses `data/known_hosts` instead of your global `~/.ssh/known_hosts`. This fixes most stale host key conflicts caused by Tailscale IP reuse, machine reinstallations, or renamed Macs.

If it happens again for the same machine after its SSH host key changes, remove the matching line from `data/known_hosts` and start the tunnel again.

### `Permission denied (publickey)`

Make sure the MacBook running this console can SSH into the target machine:

```bash
ssh SSH_USER@100.x.y.z
```

## Current Scope

This is a local management-console MVP. It does not store remote service tokens in the management app. Dashboard auth URLs are generated on demand from the target Mac and opened for the user. Good next additions:

- macOS LaunchAgent for background startup
- Per-machine health checks
- Saved service presets
- Multi-user login
- Tailscale API OAuth discovery for offline devices
- WebSocket tunnel status updates
