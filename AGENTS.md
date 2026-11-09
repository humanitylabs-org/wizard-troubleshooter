# Agents working on wizard-troubleshooter

Wizard's independent backup line: a status page, a fixed set of one-tap restarts, a repair chat that talks straight to a model provider, and a `wizard-guardian` timer that heals links and starts a repair conversation. It must keep working when the Wizard shell, Agent Service and Hermes are all down. Read [README.md](README.md) for behaviour and configuration. Checked against the code on 5 Nov 2026; if a command here fails, fix this file in the same PR.

## How it fits

- **wizard-app-manager** installs it natively (`wam troubleshooter`, pinned to the commit a release names) and supplies the box layout, ports and the connection-app registry it links to for sign-in.
- **wizard-agent-service** and **Hermes** are deliberately *not* in the repair path; the page only reads their health and the app list the Agent Service uses.
- **wizard-ux** opens `/troubleshoot/` in a window. The page borrows the shell's skin and Back through `app-client.js` when hosted, and falls back to its own tokens when the shell is down.
- Wizard behaviour never goes into Hermes core.

## Layout

- `server.mjs`: HTTP server, owner gate, routes (listens on 127.0.0.1:9691 under `/troubleshoot/`).
- `web/index.html`: the whole UI in one self-contained file (markup, `:root` tokens, inline script). No external fonts or URLs.
- `lib/`: `checks.mjs` health checks, `providers.mjs` Claude/ChatGPT/Tinfoil routing and fallback, `toolloop.mjs` shared `toolDefs()`/`callTool()`, `repair-tools.mjs` and `repair.mjs` owner-approved repair policy, `reply-health.mjs` and `agent-reply.mjs` real-reply probes, `launchers.mjs` app addresses, `wam.mjs` which App Manager command a repair may use, `codex-turn.mjs` legacy adapter.
- `bin/`: `status.mjs`, `guardian.mjs`, `repair-app-addresses.mjs`, `repair-mcp.mjs`, `host-operations.mjs`. `deploy/`: systemd units, Caddy and Tailscale Serve snippets. `REPAIR_PROMPT.md`: the repair model's brief.
- `tests/*.test.mjs`: one file per concern. `tests/ui/`: hermetic browser QA. Historical plan: [docs/history/PLAN.md](docs/history/PLAN.md).

## Setup, tests, checks

Node 22 (CI). **No dependencies and no install step**; `package.json` has no lint or type-check script. `git diff --check` for whitespace.

```sh
npm test                    # node --test tests/*.test.mjs  (the only CI job, "test")
```

CI (`.github/workflows/test.yml`) runs `npm test` on every PR and on pushes to `main`. At the time of writing `main` has **no branch protection and no required checks**, and there is **no secret-scan workflow**: before pushing, scan your diff yourself (for example `gitleaks git . --no-banner --redact --log-opts="origin/main..HEAD"`) and check that no token, path or host from a real box appears in code, tests or PR text. Read the `test` result on the exact PR head.

Disposable instance (never against a real box's state):

```sh
S=$(mktemp -d)
TROUBLESHOOT_DEV_NO_AUTH=1 TROUBLESHOOT_STATE=$S HOME=$S PORT=29691 node server.mjs
# open http://127.0.0.1:29691/troubleshoot/ ; stop it and delete $S afterwards
```

`TROUBLESHOOT_DEV_NO_AUTH=1` turns the owner gate off and is for local tests only. Real installs are the systemd units in `deploy/` ([README.md](README.md) install sections).

## Conventions that matter

- **Reuse, don't fork.** Provider routing, the connection-app registry links, `appLink`, action buttons, model picker, incident log and owner-approved repair tools already exist: extend them, never build a parallel login, UI or privilege path. This repo has no CI reuse gate; say in the PR body what you REUSE, EXTEND or add as NEW, one line each (the format [docs/history/PLAN.md](docs/history/PLAN.md) uses). Shared-component rules live in wizard-ux `docs/COMPONENTS.md`.
- **Fail closed and stay safe.** Repair writes and commands need an explicit owner approval click; the model never approves itself; deny, timeout, Stop or restart means no action. `REPAIR_POLICY_FILE` grants nothing by default. Tokens, keys and session ids never reach conversations, logs or tests (`tests/reply-health.test.mjs` and `tests/repair-tools.test.mjs` pin this). Never give the model a general shell.
- **Keep every existing live action and warning.** Real answers and repairs in progress are never replayed. The guardian starts the repair chat only after two real failed reply checks, and never restarts services to fix an expired sign-in.
- **UI rules** (same as wizard-ux): a tap paints on the same frame and never waits for the backend or a poll; Back moves one step at a time and never exits abruptly (today: the Details sheet closes first, then the page's Back link returns to the Wizard shell); tapping outside a sheet closes it (keep that when touching `dialog#sheet`); Appearance v1 `--wz-*` roles with live skin changes when hosted, and a standalone fallback that uses system colours so the page still works when the shell is down (`web/index.html` head comment); floating text panels fully opaque; check two skins at phone size.
- App workflows and approved behaviour ship in this repo's source and release, not in an agent's notes or a box's local edits (per-box policy lives only in `REPAIR_POLICY_FILE` and `prefs.json`).

## Browser check

`node tests/ui/run-qa.mjs [outdir]` starts a throwaway server with a fake provider (`tests/ui/fake-claude.sh`), a temp state dir that it deletes, dummy ports and no host sign-ins, then drives `tests/ui/chat-qa.cjs`. Playwright is not a dependency: install it yourself or set `PLAYWRIGHT` (module path) and optionally `CHROME`. It covers phone (390x844 and 320x640) and desktop sizes, dark and light skins, and both Claude and ChatGPT reconnect flows. It is synthetic evidence only; there is no live-provider harness, and no screenshot-diff tool. Say what you could not check.

## How a change reaches users

1. A PR merges to `main`; CI runs `npm test`. There is no image or release workflow in this repo.
2. Boxes get it from App Manager's installer, pinned to the commit named in the WizardOS release metadata (wizard-app-manager `releases/`, gate in `wam/updates.py`). A release or pin bump is a separate, authorized change in that repo. Merging here does not update any box.
3. The agreed policy (boxes on plain `main` = Latest, Stable after a soak, `hotfix` skips it) is in the Team workflow below.

## Team workflow

Agreed 5 Nov 2026 and being rolled out by Miguel; tracking issue: [wizard-ux#887](https://github.com/humanitylabs-org/wizard-ux/issues/887). This is agreed policy, not a claim that every label, switch or release job already enforces it. This repo has no older team-rules block; if you see one in a sibling repo, this section wins over it.

- **Humans file issues, agents write PRs.** Every PR links an issue. If none exists, the agent files one from the human's request.
- **Two issue kinds.** *Goals* are big and closable with a done-list; only humans open and close them; there is no permanent catch-all Goal. *Bugs* are small: a core-team human's bug is accepted; outside reports and agent-drafted issues wait for a human yes. Bugs need no parent Goal.
- **Priority:** labels P1–P3 (older `priority: 1/2/3` labels are the same levels). Agents take P1 first. Triage is weekly and async.
- **`main` is the only truth.** Everyone's box runs plain `main` (**Latest**). Users get a **Stable** release cut from approved work after a soak. A breaking or data-loss fix is labelled `hotfix` and skips the soak once tests pass.
- **New features ship behind off-by-default switches** (the existing Look switches). A "works" from a human who did not build the feature makes it the default and removes the switch. A big redesign that cannot be switched gets a temporary preview link, never a device branch.
- **Review:** a non-author agent reviews "is it safe and sound" and merges the same day. **Authors never merge their own PRs.** Never change branch protection, settings, boxes or deployments as part of a change.
- A single company implementer agent is being trialled; until then the existing team agents implement under these rules. Put knowledge in the repo, not in an agent's memory.

Branch names are purpose-prefixed and lowercase (`fix/`, `feature/`, `docs/`), pushed after every commit. PR bodies say what changed, the issue, the exact commands run with results, and what was not checked.
