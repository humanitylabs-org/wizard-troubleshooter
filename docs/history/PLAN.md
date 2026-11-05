# Expired sign-in recovery

Outcome: an expired AI sign-in cannot make the backup repair chat look answered, or make the guardian call an unresponsive agent healthy. A phone user can reconnect through the existing connection app without opening a terminal.

- REUSE: provider routing, connection-app registry links, appLink, action buttons, model picker, incident log and owner-approved repair tools.
- EXTEND: failure classification, independent real reply checks and guardian incident handling; the existing header gains one reconnect action.
- NEW: no parallel UI or login implementation. Small server-only reply cache and legacy Codex transport use the existing tool-loop authority boundary.

Acceptance:
- The observed non-synthetic expired OAuth stream falls through to ChatGPT; usage notices do too. Real answers and already-started repairs are not replayed.
- The main-agent probe rejects HTTP 200 provider-auth errors. Healthy probes are shared for ten minutes; failures retry after one minute. On-demand checks bypass the cache.
- The guardian counts distinct probes, reports once after two failures, starts an independent repair conversation, never spends restarts on sign-in failures, and records recovery.
- The header shows one reconnect link from the existing app registry. Both Claude and ChatGPT work on a phone, with the normal agent unavailable.
- Preserve all live actions and warnings. Run unit tests, phone QA on Forum under two skins, the live-source comparison, and an isolated forced-Claude-failure rehearsal. Keep the existing service drop-ins. Do not merge.
