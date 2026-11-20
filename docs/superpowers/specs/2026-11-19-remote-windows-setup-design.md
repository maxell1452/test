# Remote setup: Chrome/Teams on Windows, Claude + bridge on Linux (short design)

## Intent
The Teams call runs in Chrome on a Windows machine. Claude Code and the bridge run on a Linux machine that drives Windows over RDP. Both sit on the Windows mobile hotspot LAN. Answers appear in the Linux terminal. No stated reason for the split beyond "I want this setup".

## Goals
- Extension on Windows reaches the bridge on Linux with **no change to extension or bridge code**.
- Bridge stays bound to `127.0.0.1` on Linux; nothing new is exposed on the LAN.
- Alt+Shift+K / Alt+Shift+J work as today (user confirms keys pass through RDP to Windows Chrome).

## Non-goals
- No LAN-exposed bridge, no shared token, no configurable bridge URL in the extension.
- No Meet support, no change to the README's "mock interviews only" warning.

## Anti-goals
- Do not weaken the Origin/Host guards in `bridge/app.ts` to make the remote case work.

## Approaches considered
- **A. SSH local-forward from Windows to Linux (chosen).** `ssh -N -L 8787:127.0.0.1:8787 <user>@<linux-ip>` on Windows; Windows `127.0.0.1:8787` now reaches the Linux bridge. Zero code change, SSH supplies auth + encryption. Cost: an extra terminal on Windows; edit the command if the Linux IP changes.
- B. Bind bridge to LAN IP + configurable extension URL + token. Touches bridge, extension, manifest, tests; plain HTTP on LAN; same IP-drift problem. Rejected: more code and attack surface for no gain.
- C. Reverse tunnel (`ssh -R`) from Linux. Needs an OpenSSH server on Windows. Rejected: heavier than A.

## Design
1. Linux: `sshd` already active on :22 (verified). Claude Code started from repo root with `claude --dangerously-load-development-channels server:interview-bridge` (bridge listens on `127.0.0.1:8787`).
2. Windows: keep the tunnel command running; load `extension/` (copy from Linux, e.g. `extension.zip`, after `bun run build`) via Load unpacked in Windows Chrome; set `selfNames` there.
3. Docs: add a "Remote setup (Linux drives Windows)" section to `README.md` with the steps above, a `Test-NetConnection <linux-ip> -Port 22` check, and troubleshooting rows (`DOWN` = tunnel not running or bridge not up; IP changed after hotspot switch).
4. Optional: `tools/tunnel.ps1` (one-line wrapper taking the Linux IP). Not built unless asked.

## Verified so far
- Tunnel is up: established SSH session from Windows (192.168.1.12) to Linux (192.168.1.7:22).
- A bridge is listening on `127.0.0.1:8787`, but `channelLoaded: false` / `pendingAck: true`, so the current Claude session is not a channel-enabled one.

## Open / left to the builder
- Linux IP on the hotspot subnet (currently on home Wi-Fi 192.168.1.x). Same command, new IP.
- Whether hotspot client isolation or `ufw` blocks :22 once on the hotspot.
- Windows Chrome + Teams scraper remain untested (README acceptance test applies).
- Optional hardening: SSH key instead of password; `-o ServerAliveInterval=30` so the tunnel survives idle.
