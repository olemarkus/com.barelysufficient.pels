# Settings UI Views

This directory contains Preact page components. Pass data as props from the orchestrator; do not read global mutable state or build views through imperative DOM mutation. A small `render(...)` mount wrapper is fine. `useRef` with `useLayoutEffect` is permitted for Material Web properties that HTML attributes cannot set.

Use Material Web controls when their semantics fit. Reuse shared PELS display primitives and design tokens for the rest; avoid page-local control systems. Keep browser-only formatting and state resolution in settings UI. Move pure logic to `packages/shared-domain/` only when the Node runtime also uses it.

Design for Homey's narrow WebView: keep 320 px usable and 480 px as the effective upper width. For meaningful visual changes, inspect the rendered UI in a real browser at narrow widths, including text fit, overflow, touch targets, and contrast. Use `notes/ui-terminology.md` for user-facing wording.
