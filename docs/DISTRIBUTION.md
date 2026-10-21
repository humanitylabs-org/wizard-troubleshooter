# Distribution candidate and acceptance gates

## What works in this branch

- Root `wizard.md`, skill, Runtipi config and a deterministic inline recipe. It uses a pinned multi-architecture Node base; no app-image publishing or private registry credential is necessary.
- Normal sandbox: non-root, read-only root, dropped capabilities, bounded tmpfs and no bind mounts, Docker socket, host network, host PID or dependency on Agent Service/Hermes.
- `/troubleshoot/api/ping` reports **process** health and `ready:false`; `/troubleshoot/api/readiness` returns 503. Read-only MCP `recovery_readiness` gives the owner the independent SSH/console repair-kit link.
- Host chat/actions/guardian fail closed in app mode, even if someone accidentally enables the development auth bypass. The native host service keeps its existing behavior.
- Dockerfile for reproducible runtime tests. `scripts/package-app.py` embeds the same reviewed files into the normal app recipe; regenerate after every runtime edit.

## Why this is not yet the default recovery solution

The existing service launches native Claude/Codex with host access and calls systemd/Docker/deploy helpers. Its checks and prompt currently name a development host's Caddy, user Tailscale, gateway, candidate interface and host-service layout. Fresh WAM installs instead use stock host Tailscale Serve and Runtipi containers. A recipe cannot safely inherit those host powers; changing compose to mount the owner's home or Docker socket violates the app safety boundary.

Do not merge the dependent default-app PR as a launch solution until these gates close:

1. **Trusted host component**: WAM/installer owner provisions a narrowly authenticated host service separately from app recipes, discovers fresh and alongside layout, preserves queue state, and survives the Agent Service, agent and app-manager API being stopped. Package/catalog presence is not this implementation.
2. **Owner-only independent route**: native Tailscale Serve-compatible owner identity and anti-CSRF; do not trust spoofable headers on the app network. The existing Caddy `X-Private-Peer` + whois route is not automatically installed by WAM. Preserve existing Serve mounts; never reset the gateway. Test another tailnet user and spoofed local request denial.
3. **Native engine installation/sign-in**: verify supported CLI executable, version and actual host login. Fresh Claude shared-volume login and Hermes ChatGPT auth are not automatically repair-CLI logins. Owner completes sign-in; tokens are never copied or returned to the app. No automatic guardian full-access repair merely because an app was installed.
4. **Publication**: this repository is private. Public index crawling needs a public, checker-valid repo with `wizard-app` topic. A new owner must not need Humanity Labs GitHub membership. Repo visibility needs owner authorization; do not publish private existing history as a shortcut.
5. **Pinned releases**: Oscar owns WAM/default release pins and `wizard-os/releases`. The slot row alone does not reach release-pinned boxes. Add the release row only after a reviewed installable companion commit and its host provisioning are accepted.
6. **Acceptance**: disposable fresh-box install (lane L4), direct real owner chat, negative auth tests, agent-down repair, phone, restart/update and real backup restore. Fake model tests are transport tests, never evidence that a host was repaired. If a future app view is added, Appearance v1 / two skins / mobile Back acceptance also applies; this candidate has no view.

## Local validation

```sh
python3 scripts/package-app.py
npm test
# From a WAM checkout/environment:
wam check /path/to/wizard-troubleshooter
```

The Docker smoke should separately prove native-mode fake chat transport and isolated-mode refusal. Native-mode test auth bypass is allowed **only in a disposable loopback test container with synthetic state and a fake executable**, never in the installed recipe or live service.

No installer, live service, host authentication, Tailscale route, guardian or release pin is changed by this packaging candidate.
