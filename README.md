# Wizard Troubleshooter

Wizard's backup line: open it, tap **My Wizard is down, please fix it**, and an AI using the sign-in held by
your Wizard connection apps (Claude, ChatGPT or Tinfoil) fixes the server. It lives at `/troubleshoot/` on the owner's private Wizard address. It depends only on the
private network and the HTTPS front door; the sign-in bridge, Wizard shell, Agent Service and Hermes can
all be down and it still works.

- **Calm, single-focus screen**: one quiet status line at the top (a still dot and one sentence: "Everything is
  working" / "Something's wrong: <one thing>" / "Fixing…"; the dot breathes gently only while fixing, and not at all
  with reduced motion), the conversation as the main area, and one primary action (**Fix it**) only when a check
  fails. Each run of agent checks folds into one "N steps" line. Everything else (all checks, sign-ins, manual fixes,
  recent rescues) sits behind **Details**, a sheet. The look borrows "The Monospace Web" (a printout on a character
  grid) in plain CSS: monospace type, thin rules, one restrained amber accent. It follows the shared app rules
  (wizard-os `style/APP-DESIGN-RULES.md`): the window is the page, layout by window width with container queries, no
  title in a window, pop-ups are `.wz-sheet` (×, Esc, outside, Back, swipe). It must work while the rest of Wizard is
  down, so `web/index.html` is self-contained: its own colour tokens in one `:root` block (light and dark), the sheet
  behaviour inlined, no fonts or external URLs (the optional shell app client only adds skin roles for the diagnosed
  sign-in path). In a Wizard window it takes the shell's light/dark choice (Appearance v1).
- **Past sessions**: every repair conversation is already kept as one scrubbed JSON file in
  `<state>/conversations/` (newest 100 kept; never the running one removed; no tokens or Claude session ids are
  exposed). `GET /api/repairs?limit=1..50` lists them newest first (date, first line, origin); `GET /api/repair/<id>`
  returns one thread. The page shows them in a quiet left column on wide windows and in a **Sessions** sheet on narrow
  ones; a past session opens read-only (`#past=<id>`), **New session** starts a fresh one.
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
  the chat says so plainly. An expired sign-in or usage-limit notice (including assistant-text notices) is not
  an answer: the next provider takes over with a visible note. The saved preference stays unchanged. A missing
  connection still offers **Ask <next> instead**. The header shows one **Sign in to Claude again** (or ChatGPT)
  link from App Manager's existing connection-app registry; no separate login page or normal-agent dependency. The Guardian's automatic repairs still use the order Claude, then ChatGPT, then Tinfoil. Runs survive the browser disconnecting. Briefed by `REPAIR_PROMPT.md`, with this
  box's wiring filled in from configuration.
  - **Claude** (Claude app): Claude Code runs with built-in tools disabled and only the shared repair MCP tools, using the login directory the Claude
    app's engine mounts (`~/.claude`, or `CLAUDE_CONFIG_DIR`). Used in place. Claude Code renews it itself.
  - **ChatGPT** (ChatGPT app): the ChatGPT app keeps no token of its own. It signs in through the agent's credential
    store (`credential_owner: hermes`), the file `~/.hermes/auth.json` (`CHATGPT_AUTH_FILE`). The Troubleshooter
    reads the current access token from that file at call time and calls the ChatGPT Codex endpoint directly. Hermes
    does not need to be running. It never refreshes or copies the token: refresh tokens are single-use. If the
    current sign-in is rate-limited or rejected, the next pooled sign-in in the same store is tried. Legacy boxes
    whose sign-in is in Codex use `CODEX_BIN`/`CODEX_HOME` through an ephemeral, read-only JSON-turn adapter.
    Its shell, execution, MCP, hooks, plugins and web tools are disabled; only the shared owner-approved tools run.
  - **Tinfoil** (Tinfoil app, private): the Tinfoil key never leaves the app. The Troubleshooter calls the app's
    box-only, attested `/v1/chat/completions` gateway with the app's local gateway credential, which it reads from the
    app's store at call time (`docker exec … cat /data/private/gateway-token.json`, or `TINFOIL_TOKEN_FILE`).
  - All providers share `toolDefs()` and `callTool()` in `lib/toolloop.mjs`. Claude uses a token-gated loopback MCP bridge; ChatGPT and Tinfoil use a **bounded tool loop** (12 steps). There is no provider-specific privileged shell. They have `check_status`, `run_fix` (the fixed one-tap fixes, refused for a link
    that is working right now), and read-only `service_status`, `journal_tail`, `docker_ps`, `docker_logs`,
    `disk_usage` and `memory_usage`, with fixed argument shapes. Tool output is size-capped and scrubbed of
    token-shaped strings. Conversations and logs never contain a token, key or gateway credential.
  - The shared `repair_scope`, `read_file`, `write_file`, and `run_command` tools provide bounded host repair. Configure `REPAIR_POLICY_FILE` to an owner/admin-controlled JSON file with exact `files` and fixed `commands`. No policy means no file or command grants, not unrestricted access. Writes and command execution require an explicit **Approve this exact action** click in the owner-gated page; the model cannot approve itself. Denial, timeout (five minutes), Stop, or service restart fail closed. Guardian chats cannot approve these operations. Existing one-tap targets are retained; repair-chat `run_fix` now also requires owner approval before executing. `REPAIR_STANDBY_LOCK` fences mutations when the host is standby; `REPAIR_PROTECT_HERMES=1` refuses the gateway self-stop path (use an idle out-of-band operator). The Troubleshooter cannot restart itself from a running repair.
  - Example policy (use your own exact paths): `{"files":["/home/wizard/repair-fixtures/config.json"],"commands":{"verify_config":{"executable":"/usr/bin/node","args":["/home/wizard/repair-fixtures/verify.cjs"],"cwd":"/home/wizard/repair-fixtures"}}}`. Policy commands are administrative authority: review the executable/script and arguments before granting them; never grant a general shell or a script that an allowed file edit can change. The model supplies only the command id, not argv. No API can expand policy. File edits are limited to existing small (4 KiB), non-secret regular files, deny symlinks/hardlinks and protected agent/sign-in/database paths, require a fresh SHA-256, retain a private backup, and read back the result. File content/command approval details are shown to the owner before execution.
  - **Repair plans (on by default since 9 Nov 2026; off by default before, #37).** The repair policy is `REPAIR_POLICY_FILE`, default `~/.config/wizard-troubleshooter/repair-policy.json`; no file (every fresh install) or a policy without `"plans"` means on, `"plans": false` turns them off, an unreadable policy is off. They let the repair AI read code and logs (`inspect_file`, `list_dir`, `search_text`, read-only, never private agents, Messenger, recordings or sign-in files) and propose ONE concrete repair with `propose_repair`: exact bash commands and/or exact file edits plus verify commands. The page shows the exact plan with **Approve and run** / Don't run; the tap sends back the plan's sha256 digest, and a changed, dismissed, expired (24 h) or already-approved plan is refused. `bin/execute-plan.mjs` runs it in its own transient user unit (`systemd-run --user`), so it survives restarts of Hermes, the Agent Service or the Troubleshooter (the unit inherits nothing, so the repair policy and box layout settings are passed to it with `--setenv`; tokens never are); it backs up every touched file, writes a transcript, runs the plan's checks and Hermes/Agent Service health, and **Undo** restores the backups. The switch is read on every call: `"plans": false` stops new tools, approvals and runs at once (undo of an earlier run still works). Without it nothing changes from the fixed allowlist above.
  - Operational grants may use `files: [{"path":"/exact/unit.conf","writable":false}]` for inspection only, or `{"path":"/exact/repair-delay.conf","writable":true,"format":"restart-delay"}`. The latter accepts **only** `[Service]` + `RestartSec=2..60` + newline, not `ExecStart`, environments, security directives, or other unit fields. Never grant arbitrary writes to a service unit: that would be a shell-equivalent escape. Format and writable grants are rechecked after owner approval and immediately before commit. `bin/host-operations.mjs` is the local administrative target (it resolves the owning user's home and runtime directory, so it works on any box): registry structure summary (not raw registry contents), recovery-config validation/effective systemd readback, user daemon-reload, and only four named auxiliary-unit restarts. It is not itself writable by repair tools. It never changes routes, auth, host roles, deployment targets, or network security. The repair policy file itself stays per-box and opt-in: a fresh box grants nothing until its owner adds reviewed paths and commands.
  - ChatGPT defaults to the subscription-verified `gpt-6.1-sol` (`CHATGPT_MODEL` still overrides it). Returned model substitutions are refused. The saved engine preference remains unchanged during auth/limit fallback. Claude quota/system notices are not stored as successful answers or fake model labels. Auth readiness is not a promise of remaining provider quota.
- **Guardian** (`wizard-guardian.timer`, every minute): restarts a link after 2–3 consecutive failed checks,
  undoes a fresh Agent Service update if a restart doesn't help, and after ~6 failed minutes starts a repair
  chat itself. It waits while an Agent Service deploy holds `deploy.lock`, caps restarts at 3/hour per link,
  and if a restart did not keep a link working for 30 min it does not restart that link again for an hour,
  escalating once instead. An Agent Service that answers its front page but is slow with its health check, or
  whose health says Hermes is slow to accept new messages (`queue.hermes_slow_to_accept`), is *busy*, not down:
  never restarted and logged once per episode. It reports once into the owner's Wizard thread (`GUARDIAN_THREAD`). Optional, off by default (`TROUBLESHOOTER_REPLY_PROBES=1`): it also sends a tiny real message through
  the main agent (`Your agent can reply`) and every connected repair engine. An HTTP 200 response containing
  a provider-auth failure is a failed reply, not a healthy service. Healthy results are shared for ten minutes;
  failures retry each minute. `GET /api/status?fresh=1` forces a new check. After two distinct failed main-agent
  replies, it reports the outage and starts the independent backup repair chat. A dead sign-in spends no restart
  budget. Recovery is logged and reported once. Keys and provider output are never saved in the probe cache.
  Default is off because those messages cost tokens all day (~144 main-agent turns, ~430 provider pings) and a
  failed probe alone can declare Wizard down. Without them, a sign-in or limit failure is still caught from real
  repair-chat replies.

Owner gate: the service takes the peer address from the front door and confirms a human (untagged) tailnet principal
via Tailscale whois, the same policy as the sign-in bridge, without depending on it. With `TROUBLESHOOT_OWNERS` set,
only those logins get in.
- Caddy (`TROUBLESHOOT_FRONT=caddy`, default): Caddy sets `X-Private-Peer` from the real connection.
- Tailscale Serve (`TROUBLESHOOT_FRONT=tailscale-serve`): Serve proxies from loopback and replaces `X-Forwarded-For`
  with the peer's tailnet address. Only a loopback connection carrying a single tailnet address is trusted. Serve's
  `Tailscale-User-Login` must agree with whois.

POSTs need the private origin plus `X-Wizard-Troubleshoot: 1`. The guardian uses a loopback-only token.

- **App addresses** (`Apps open inside Wizard`, `lib/launchers.mjs`): every installed app that opens at a path on the
  Wizard origin (`/messenger/`, `/files/`) must keep that path as its launcher address in both `apps.json` copies
  (`~/.wizard-os` and the Runtipi share the Agent Service reads). Paths seen in `links.json` or a healthy `apps.json`
  are remembered (`launchers.json` in the state dir), so a run that rewrote both files to a raw port is still caught.
  After 2 failed minutes the fix (`bin/repair-app-addresses.mjs`) backs up the three files to
  `launcher-backups/<time>/` (last 20 kept), runs the box's `wam links --json`, reads the addresses back and logs an
  `app-addresses-repair` incident. It restarts nothing, so the guardian applies it even when report-only
  (`GUARDIAN_HEAL_ADDRESSES=0` keeps report-only strict; `APP_ADDRESSES=0` turns the check off).

The guardian is report-only with `GUARDIAN_ACT=0`: it logs what it would fix and never restarts, rolls back or starts a
repair (app-address repairs excepted, see above).

Install (Tailscale Serve box, e.g. a Runtipi/WAM Wizard): copy the units as below, then use
`deploy/tailscale-serve/troubleshooter.conf` as the drop-in for both services (fill in the names), add
`deploy/tailscale-serve/guardian.conf` to the guardian, and mount the routes with
`deploy/tailscale-serve/routes.sh 8444 8806` (it backs up `tailscale serve status --json` first). The shell's built-in
Troubleshooter app opens `/troubleshoot/` on the same origin, so mount it on every port the shell is served on.

Install (Caddy box): copy `deploy/*.service` and `deploy/wizard-guardian.timer` to `~/.config/systemd/user/`, add a drop-in
with `WIZARD_PUBLIC_NAME` (and `GUARDIAN_THREAD` for the guardian), add `deploy/troubleshoot.caddy` to the
private site block, validate Caddy, reload. Units: `wizard-troubleshooter.service` (port 9691),
`wizard-guardian.service` + `.timer`.
Every new WizardOS box gets this native install from the installer (wizard-app-manager `wam troubleshooter`), pinned to
the commit its release names: units, a generated drop-in with this box's layout (owner login from the box's own
Tailscale sign-in, shell/Agent Service ports and containers from App Manager), guardian report-only, and `/troubleshoot`
on every shell HTTPS port. Where Hermes's CLI exists (`HERMES_BIN`, default `$HERMES_HOME/hermes-agent/.hermes/bin/hermes`,
`HERMES_HOME` default `~/.hermes`), **Restart your agent (Hermes)** is the gateway's own drain restart (`hermes gateway restart
--interrupt`, in its own transient unit outside the gateway), not `systemctl restart`, which fenced boxes refuse
(`RefuseManualStop=yes`). A drain takes minutes; while it runs (Hermes's `gateway_state.json` says draining, the journal says
`runtime_draining`, or a restart asked for here hasn't landed) the Hermes check is *busy* "Restart in progress", the guardian
leaves it alone, and the repair chat waits for it to land (`HERMES_RESTART_WAIT_MS`, 60 s) instead of calling an unchanged PID
a failed restart. The drain is bounded (9 Nov 2026: 19 work units, mostly scheduled tasks, held every new message back for
~10 min behind a 30 min cap): `bin/hermes-restart.mjs` stops waiting after `HERMES_FORCE_AFTER_S` (180 s) without a new
process, by SIGTERM to the gateway's main process (`systemctl --user kill --kill-whom=main`, not a stop job, so the fence
allows it; the gateway runs its own bounded shutdown, pausing turns that resume afterwards, and `Restart=always` brings it
back), SIGKILL only if the same process is still there `HERMES_KILL_AFTER_S` (240 s) later; a drain command that fails
restarts directly. While somebody else's drain runs (an update, a reload), the check says how long and on what it waits
and offers **Restart your agent now** (`force-restart:hermes`); the guardian does that itself once the drain has held
messages back (replies not starting) for `GUARDIAN_DRAIN_FORCE_MIN` (10). A unit systemd restarted `CRASH_LOOP_RESTARTS`
(3) times in 15 min is reported as crash-looping with its last error, and the guardian asks the repair chat for the cause
instead of restarting it again. `wizard-run-keeper.service` (where installed) is checked by its socket and restartable.
The guardian also restarts `wizard-troubleshooter.service` when `/troubleshoot/api/ping` misses two minutes in a row,
report-only mode included (`TROUBLESHOOT_UNIT=''` turns that off). The repair chat never sends the owner to Telegram,
a console, SSH or another tool. A box whose Hermes runs as the `hermes-agent` app has no host Hermes port: `HERMES_PORT=0`
judges Hermes from the Agent Service's `upstream_reachable` and `HERMES_CONTAINER` restarts it. `GUARDIAN_TZ` sets the
time zone of the guardian's reports (default: the server's).
State: `~/.local/state/wizard-troubleshooter/` (incidents.jsonl, conversations/, guardian.json).
Tests: `npm test` (service, guardian, provider routing/fallback/sign-ins, Tinfoil and ChatGPT tool loop, owner gate, no secrets in logs); `tests/ui/chat-qa.cjs` (phone-size chat flow in Playwright).

Relation to the isolated app (#2): this is the **native host install**. It runs as user systemd units with host
authority, so it can restart host units and containers and read the connection apps' stores in place. #2 stages the
**isolated Runtipi app** direction, which deliberately has no host powers and reports `ready:false`. Both share the same
code. The provider routing here works the same way once a trusted host component gives the isolated app a
narrow, audited path to those stores.
