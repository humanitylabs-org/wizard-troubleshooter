# Wizard Troubleshooter

Wizard's backup line: open it, tap **My Wizard is down, please fix it**, and an AI using the sign-in held by
your Wizard connection apps (Claude, ChatGPT or Tinfoil) fixes the server. It lives at `/troubleshoot/` on the owner's private Wizard address. It depends only on the
private network and the HTTPS front door; the sign-in bridge, Wizard shell, Agent Service and Hermes can
all be down and it still works.

- **Chat first**: the page is a chat with quick-tap messages. Status is one pill in the header; tapping
  it opens the details sheet (checks, sign-ins, manual fixes, earlier repair chats, recent incidents).
- **Status**: plain-language checks of every link (Tailscale, HTTPS front door + certificate, sign-in check,
  app screens, Agent Service, Hermes, disk, memory). `node bin/status.mjs --accounts`.
- **One-tap fixes**: a fixed list of restarts plus "Undo last Agent Service update". No free-form commands.
- **Repair chat**: the owner talks straight to a model provider using the sign-in held by the box's Wizard
  connection apps. No Hermes and no Agent Service in the path. A **model picker** sits right above the message box:
  one segment per provider with the model it actually uses in quieter text (Claude · Opus 5.5 read from Claude Code's
  own init event, ChatGPT · `CHATGPT_MODEL`, Tinfoil · the chat model the app offers). Default is the first provider
  that is signed in (Claude first). The choice is saved on the server (`prefs.json` in the state dir, `POST
  /api/engine`), so every device shows the same one. Providers that can't answer are shown disabled with a short
  reason. Each answer is labelled with provider and model. If the picked provider's sign-in is missing or expired,
  the chat says so plainly with an **Open … app** button and offers **Ask <next> instead**; it never switches on its
  own. The Guardian's automatic repairs still use the order Claude, then ChatGPT, then Tinfoil. Runs survive the browser disconnecting. Briefed by `REPAIR_PROMPT.md`, with this
  box's wiring filled in from configuration.
  - **Claude** (Claude app): Claude Code runs with built-in tools disabled and only the shared repair MCP tools, using the login directory the Claude
    app's engine mounts (`~/.claude`, or `CLAUDE_CONFIG_DIR`). Used in place. Claude Code renews it itself.
  - **ChatGPT** (ChatGPT app): the ChatGPT app keeps no token of its own. It signs in through the agent's credential
    store (`credential_owner: hermes`), the file `~/.hermes/auth.json` (`CHATGPT_AUTH_FILE`). The Troubleshooter
    reads the current access token from that file at call time and calls the ChatGPT Codex endpoint directly. Hermes
    does not need to be running. It never refreshes or copies the token: refresh tokens are single-use. If the
    current sign-in is rate-limited or rejected, the next pooled sign-in in the same store is tried.
  - **Tinfoil** (Tinfoil app, private): the Tinfoil key never leaves the app. The Troubleshooter calls the app's
    box-only, attested `/v1/chat/completions` gateway with the app's local gateway credential, which it reads from the
    app's store at call time (`docker exec … cat /data/private/gateway-token.json`, or `TINFOIL_TOKEN_FILE`).
  - All providers share `toolDefs()` and `callTool()` in `lib/toolloop.mjs`. Claude uses a token-gated loopback MCP bridge; ChatGPT and Tinfoil use a **bounded tool loop** (12 steps). There is no provider-specific privileged shell. They have `check_status`, `run_fix` (the fixed one-tap fixes, refused for a link
    that is working right now), and read-only `service_status`, `journal_tail`, `docker_ps`, `docker_logs`,
    `disk_usage` and `memory_usage`, with fixed argument shapes. Tool output is size-capped and scrubbed of
    token-shaped strings. Conversations and logs never contain a token, key or gateway credential.
  - The shared `repair_scope`, `read_file`, `write_file`, and `run_command` tools provide bounded host repair. Configure `REPAIR_POLICY_FILE` to an owner/admin-controlled JSON file with exact `files` and fixed `commands`. No policy means no file or command grants, not unrestricted access. Writes and command execution require an explicit **Approve this exact action** click in the owner-gated page; the model cannot approve itself. Denial, timeout (five minutes), Stop, or service restart fail closed. Guardian chats cannot approve these operations. Existing one-tap restart rules are unchanged.
  - Example policy (use your own exact paths): `{"files":["/home/wizard/repair-fixtures/config.json"],"commands":{"verify_config":{"executable":"/usr/bin/node","args":["/home/wizard/repair-fixtures/verify.cjs"],"cwd":"/home/wizard/repair-fixtures"}}}`. Policy commands are administrative authority: review the executable/script and arguments before granting them; never grant a general shell or a script that an allowed file edit can change. The model supplies only the command id, not argv. No API can expand policy. File edits are limited to existing small (4 KiB), non-secret regular files, deny symlinks/hardlinks and protected agent/sign-in/database paths, require a fresh SHA-256, retain a private backup, and read back the result. File content/command approval details are shown to the owner before execution.
  - ChatGPT defaults to the subscription-verified `gpt-6.1-sol` (`CHATGPT_MODEL` still overrides it). Returned model substitutions are refused. Saved engine choice and explicit failure offers remain unchanged. Claude quota/system notices are not stored as successful answers or fake model labels. Auth readiness is not a promise of remaining provider quota.
- **Guardian** (`wizard-guardian.timer`, every minute): restarts a link after 2–3 consecutive failed checks,
  undoes a fresh Agent Service update if a restart doesn't help, and after ~6 failed minutes starts a repair
  chat itself. It waits while an Agent Service deploy holds `deploy.lock`, caps restarts at 3/hour per link,
  and reports once into the owner's Wizard thread (`GUARDIAN_THREAD`).

Owner gate: the service takes the peer address from the front door and confirms a human (untagged) tailnet principal
via Tailscale whois, the same policy as the sign-in bridge, without depending on it. With `TROUBLESHOOT_OWNERS` set,
only those logins get in.
- Caddy (`TROUBLESHOOT_FRONT=caddy`, default): Caddy sets `X-Private-Peer` from the real connection.
- Tailscale Serve (`TROUBLESHOOT_FRONT=tailscale-serve`): Serve proxies from loopback and replaces `X-Forwarded-For`
  with the peer's tailnet address. Only a loopback connection carrying a single tailnet address is trusted. Serve's
  `Tailscale-User-Login` must agree with whois.

POSTs need the private origin plus `X-Wizard-Troubleshoot: 1`. The guardian uses a loopback-only token.

The guardian is report-only with `GUARDIAN_ACT=0`: it logs what it would fix and never restarts, rolls back or starts a
repair.

Install (Tailscale Serve box, e.g. a Runtipi/WAM Wizard): copy the units as below, then use
`deploy/tailscale-serve/troubleshooter.conf` as the drop-in for both services (fill in the names), add
`deploy/tailscale-serve/guardian.conf` to the guardian, and mount the routes with
`deploy/tailscale-serve/routes.sh 8444 8806` (it backs up `tailscale serve status --json` first). The shell's built-in
Troubleshooter app opens `/troubleshoot/` on the same origin, so mount it on every port the shell is served on.

Install (Caddy box): copy `deploy/*.service` and `deploy/wizard-guardian.timer` to `~/.config/systemd/user/`, add a drop-in
with `WIZARD_PUBLIC_NAME` (and `GUARDIAN_THREAD` for the guardian), add `deploy/troubleshoot.caddy` to the
private site block, validate Caddy, reload. Units: `wizard-troubleshooter.service` (port 9691),
`wizard-guardian.service` + `.timer`.
Every new Wizard OS box gets this native install from the installer (wizard-app-manager `wam troubleshooter`), pinned to
the commit its release names: units, a generated drop-in with this box's layout (owner login from the box's own
Tailscale sign-in, shell/Agent Service ports and containers from App Manager), guardian report-only, and `/troubleshoot`
on every shell HTTPS port. A box whose Hermes runs as the `hermes-agent` app has no host Hermes port: `HERMES_PORT=0`
judges Hermes from the Agent Service's `upstream_reachable` and `HERMES_CONTAINER` restarts it. `GUARDIAN_TZ` sets the
time zone of the guardian's reports (default: the server's).
State: `~/.local/state/wizard-troubleshooter/` (incidents.jsonl, conversations/, guardian.json).
Tests: `npm test` (service, guardian, provider routing/fallback/sign-ins, Tinfoil and ChatGPT tool loop, owner gate, no secrets in logs); `tests/ui/chat-qa.cjs` (phone-size chat flow in Playwright).

Relation to the isolated app (#2): this is the **native host install**. It runs as user systemd units with host
authority, so it can restart host units and containers and read the connection apps' stores in place. #2 stages the
**isolated Runtipi app** direction, which deliberately has no host powers and reports `ready:false`. Both share the same
code. The provider routing here works the same way once a trusted host component gives the isolated app a
narrow, audited path to those stores.
