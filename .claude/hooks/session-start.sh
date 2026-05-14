#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# cdn.playwright.dev / playwright.download.prss.microsoft.com are not in the
# Claude Code on the web egress allowlist. Belt-and-suspenders against any
# transitive browser-download attempt during install.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
grep -q "^export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1" "$CLAUDE_ENV_FILE" 2>/dev/null \
  || echo "export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1" >> "$CLAUDE_ENV_FILE"

echo "[pels session-start] installing workspace dependencies..."
if ! npm install --no-audit --no-fund; then
  echo "[pels session-start] WARN: npm install failed; continuing with existing node_modules (if any). Re-run manually if tests/lint break." >&2
fi

echo "[pels session-start] done. Playwright e2e (test:e2e / ci:test:playwright) does not run here; use unit/UI tests, e2e runs in GitHub Actions."
