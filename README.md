# Wizard Troubleshooter

Wizard's backup line, at `/troubleshoot/` on the owner's private Wizard address. It depends only on the
private network and the HTTPS front door; the sign-in bridge, Wizard shell, Agent Service and Hermes can
all be down and it still works.

- **Status**: plain-language checks of every link (Tailscale, HTTPS front door + certificate, sign-in check,
  app screens, Agent Service, Hermes, disk, memory). `node bin/status.mjs --accounts`.
- **One-tap fixes**: a fixed list of restarts plus "Undo last Agent Service update". No free-form commands.
- **Repair chat**: the owner talks straight to their Claude subscription (Claude Code CLI) or ChatGPT
  subscription (Codex CLI) running on the server with full access, briefed by `REPAIR_PROMPT.md`. Claude
  first, ChatGPT if Claude can't answer. Runs survive the browser disconnecting.
- **Guardian** (`wizard-guardian.timer`, every minute): restarts a link after 2–3 consecutive failed checks,
  undoes a fresh Agent Service update if a restart doesn't help, and after ~6 failed minutes starts a repair
  chat itself. It waits while an Agent Service deploy holds `deploy.lock`, caps restarts at 3/hour per link,
  and reports once into the owner's Wizard thread (`GUARDIAN_THREAD`).

Owner gate: Caddy sets `X-Private-Peer` from the real connection; the service confirms a human tailnet
principal via Tailscale whois (same policy as the sign-in bridge, without depending on it). POSTs need the
private origin plus `X-Wizard-Troubleshoot: 1`. The guardian uses a loopback-only token.

Units: `wizard-troubleshooter.service` (port 9691), `wizard-guardian.service` + `.timer`.
State: `~/.local/state/wizard-troubleshooter/` (incidents.jsonl, conversations/, guardian.json).
Tests: `npm test`.
