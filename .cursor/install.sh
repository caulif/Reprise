#!/usr/bin/env bash
set -euo pipefail

# Reprise requires Node.js >= 22.19.0 (enforced by the CLI at runtime via
# assertSupportedNodeVersion and by the check:node gate). The Cloud Agent base
# image resolves `node` to /exec-daemon/node (22.14.0), which is too old. Pin
# 22.19.0 through the image's nvm and expose it ahead of /exec-daemon by
# symlinking into /usr/local/cargo/bin, the first writable PATH entry present in
# every shell the agent and gates use.
NODE_VERSION=22.19.0
PATH_DIR=/usr/local/cargo/bin

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null

NODE_BIN="$NVM_DIR/versions/node/v${NODE_VERSION}/bin"
mkdir -p "$PATH_DIR"
for tool in node npm npx; do
  ln -sf "$NODE_BIN/$tool" "$PATH_DIR/$tool"
done

echo "node $(node --version) at $(command -v node)"
echo "npm $(npm --version)"

# Locked dependency install and build. Tests and gates read dist/, so the build
# must run here (see AGENTS.md / package.json).
npm ci
npm run build
