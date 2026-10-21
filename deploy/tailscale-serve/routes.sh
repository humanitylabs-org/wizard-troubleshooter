#!/bin/sh
# Mount /troubleshoot/ on the shell's Tailscale Serve HTTPS ports. Backs up the current routes first.
# Usage: deploy/tailscale-serve/routes.sh 8444 8806
set -eu
mkdir -p "$HOME/.wizard-os"
timeout 15 tailscale serve status --json </dev/null > "$HOME/.wizard-os/tailscale-serve.bak-$(date +%s).json"
for port in "$@"; do
  timeout 20 tailscale serve --bg --https="$port" --set-path=/troubleshoot http://127.0.0.1:9691/troubleshoot </dev/null >/dev/null
done
timeout 15 tailscale serve status </dev/null | grep -A1 troubleshoot
