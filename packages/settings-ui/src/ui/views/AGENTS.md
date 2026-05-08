# UI Views

This directory contains all Preact page components for the redesigned settings UI.

## Rules

- **All components must be written in Preact.** Use `.tsx` files. Do not add imperative DOM manipulation (`getElementById`, `textContent`, `innerHTML`, `hidden`, etc.) to this directory. If you need to read or write DOM state, lift it out to a non-Preact orchestrator (e.g. `planRedesign.ts`) and pass it in as props. Exception: `useRef` + `useLayoutEffect` is permitted for setting JS properties on Material Web Web Components (e.g. `.value`, `.indeterminate`) that cannot be set via HTML attributes — this is a known interop requirement of the Material Web library, not an architectural violation.
- **Use `@material/web` components for all UI primitives.** Buttons, ripples, elevation, progress indicators, chips, switches, and segmented buttons must come from Material Web, not one-off HTML/CSS. Import JSX wrappers from `./materialWebJSX.tsx`; register new Material Web elements in `../materialWeb.ts`.
- **Style through design tokens only.** No inline colours, hardcoded spacing, or magic numbers. Use `--spacing-*`, `--radius-*`, `--color-*`, `--accent`, `--warning`, `--danger`, etc. from `tokens.css`.
- **No new imperative render helpers.** Do not introduce `renderX()` functions that mutate DOM nodes. All rendering must go through Preact's reconciler.
- **Shared display logic belongs in `packages/shared-domain/src/`.** Pure text-formatting and state-resolution helpers (no DOM, no Preact) live there so they can be tested independently and reused across devices.
- **Props in, nothing global.** Components must not read from `window`, `document`, or module-level mutable state directly. Data flows in as props from the orchestrator.
