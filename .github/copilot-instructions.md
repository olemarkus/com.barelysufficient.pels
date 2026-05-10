# Copilot review instructions for PELS

See `AGENTS.md` at the repo root for repo conventions, build commands, and UI terminology rules.

## Out-of-scope review topics — do not comment on these

- ARIA attributes, roles, or landmarks
- Screen-reader support and other assistive-technology-specific behaviors

**Reason:** the user-facing UI runs only inside Homey's WebView, which does not expose accessibility APIs to assistive technologies. Comments targeting those APIs are not actionable here. Sighted-user concerns — semantic HTML element choice, color contrast, and keyboard navigation — remain in scope and welcome.
