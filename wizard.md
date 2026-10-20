---
wizard: 0.2
id: wizard-troubleshooter
name: Wizard Troubleshooter
type: service
category: system
version: 0.1.0
summary: "Recovery readiness and the independent repair-kit handoff. Host repair provisioning is not yet included."
license: UNLICENSED
source: https://github.com/humanitylabs-org/wizard-troubleshooter
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
system: true
provides:
- troubleshooter
uses: []
skill: skill/SKILL.md
health: /troubleshoot/api/ping
mcp:
  path: /troubleshoot/mcp
  port: 9691
---

# Wizard Troubleshooter — packaging candidate

**Not yet a fresh-box recovery path.** The sandboxed app reports `ready: false` until an independently authenticated host repair component is implemented and provisioned. It does not execute repair chat, one-tap actions or the guardian. Do not treat process health or slot occupancy as host-recovery acceptance.

The existing native host service remains separate and unchanged. It can run when Hermes and Agent Service are down, but its current development-box layout and Caddy route are not installed by this recipe. See `docs/DISTRIBUTION.md` for the precise remaining gates and the Wizard OS emergency SSH/console runbook for immediate recovery.
