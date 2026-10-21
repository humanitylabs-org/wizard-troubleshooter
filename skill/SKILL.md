---
name: wizard-troubleshooter
description: Check independent host recovery readiness without invoking the broken agent.
---

Call `recovery_readiness` to distinguish app reachability from actual host recovery. It is read-only and returns no credentials or diagnostic history. If `ready` is false, say so explicitly and point the owner to the Wizard OS `docs/REPAIR.md` SSH/console runbook. Do not claim this install can repair the host, add privileged mounts, disable auth or call host-only repair APIs from the app network. Normal app install is not authorization to launch a privileged repair agent.
