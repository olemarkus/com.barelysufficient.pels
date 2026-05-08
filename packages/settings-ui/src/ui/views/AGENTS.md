# UI Views

This directory contains all Preact page components for the redesigned settings UI.

## Rules

- **All components must be written in Preact.** Use `.tsx` files. Do not add imperative DOM manipulation (`getElementById`, `textContent`, `innerHTML`, `hidden`, etc.) to this directory. If you need to read or write DOM state, lift it out to a non-Preact orchestrator (e.g. `planRedesign.ts`) and pass it in as props. Exception: `useRef` + `useLayoutEffect` is permitted for setting JS properties on Material Web Web Components (e.g. `.value`, `.indeterminate`) that cannot be set via HTML attributes — this is a known interop requirement of the Material Web library, not an architectural violation.
- **Do not add legacy-rendered views.** New redesigned views must not use manual DOM builders, string templates, `innerHTML`, page-local `renderFoo()` mutation code, or legacy settings UI component patterns. If a non-Preact module needs to mount a view, keep it as a thin orchestrator that fetches data, finds the mount node, and passes props into a Preact view.
- **Use `@material/web` for interactive Material primitives.** Buttons, ripples, elevation, progress indicators, switches, segmented buttons, dialogs, and similar controls should come from Material Web when the semantics fit. Import JSX wrappers from `./materialWebJSX.tsx`; register new Material Web elements in `../materialWeb.ts`. Display-only rows, chips, meters, and chart marks may use semantic HTML plus shared PELS classes when that matches the existing Budget/Overview patterns.
- **Style through design tokens and shared patterns.** No inline colours, hardcoded spacing, magic numbers, or page-local CSS piled on top of tokens to create a parallel design system. Use `--spacing-*`, `--radius-*`, `--color-*`, `--accent`, `--warning`, `--danger`, etc. from `tokens.css`, and extend shared Budget/Overview or Material patterns when a new state is genuinely needed.
- **No imperative DOM render helpers.** Do not introduce `renderX()` functions that mutate DOM nodes. View entrypoints may expose a small `renderX(surface, props)` wrapper around Preact `render(...)` for non-Preact orchestrators.
- **Shared display logic belongs in `packages/shared-domain/src/`.** Pure text-formatting and state-resolution helpers (no DOM, no Preact) live there so they can be tested independently and reused across devices.
- **Props in, nothing global.** Components must not read from `window`, `document`, or module-level mutable state directly. Data flows in as props from the orchestrator.

## Material UX Guardrails

- Design for Homey settings as a narrow, mobile-first surface. Keep `320px` usable and treat `480px` as the maximum effective width for redesigned views; do not optimize or add screenshots for wider mockup layouts unless explicitly requested.
- Prefer at-a-glance layouts over clipped, horizontally scrolling panels. If dense data must fit in the narrow surface, summarize with compact bars, chips, rows, or progressive detail rather than hiding key information off-screen.
- Reuse the redesigned Budget/Overview visual language: Material 3 surfaces, list rows, compact chips, restrained chart treatments, and token-driven hierarchy. Avoid page-local card grids, legacy styling, bespoke controls, or decorative layouts when an existing M3 or PELS pattern fits.
- Optimize for intuition and scan speed. Show the decision, current state, assumed constraints, and user-relevant risk without exposing planner internals unless the page is explicitly diagnostic.
- Keep user-facing text plain and outcome-oriented. Follow `notes/ui-terminology.md` before adding labels, statuses, helper text, or chart legends.
- Use real browser inspection for meaningful visual changes. Validate narrow viewports first, including touch target spacing, text fit, no horizontal page overflow, and sufficient contrast.
