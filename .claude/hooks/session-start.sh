#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Playwright browser binaries are served from cdn.playwright.dev /
# playwright.download.prss.microsoft.com, which are not in the Claude Code on
# the web egress allowlist. Skip browser downloads during npm install and
# signal to the agent that ci:test:playwright / test:e2e cannot run here.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
grep -q "^export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=" "$CLAUDE_ENV_FILE" 2>/dev/null \
  || echo "export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1" >> "$CLAUDE_ENV_FILE"
grep -q "^export PELS_SKIP_PLAYWRIGHT=" "$CLAUDE_ENV_FILE" 2>/dev/null \
  || echo "export PELS_SKIP_PLAYWRIGHT=1" >> "$CLAUDE_ENV_FILE"

echo "[pels session-start] installing workspace dependencies..."
npm install --no-audit --no-fund

echo "[pels session-start] done. Note: Playwright e2e tests (npm run test:e2e / ci:test:playwright) are unavailable on Claude Code on the web because the Playwright CDN is not allowlisted. Use unit/UI tests instead; e2e runs in GitHub Actions."
