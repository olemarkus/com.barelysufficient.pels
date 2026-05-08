# Settings UI

- This package owns the settings UI source and tests. Work here for UI-only tasks.
- Source files:
  - `src/**` for TypeScript
  - `public/index.html` and `public/style.css` for static assets
  - `dist/` is generated output only
- Use `@material/web` for Material Design primitives when a matching component exists and the component semantics fit the UI state. Register Material Web components centrally, wrap them when needed for Preact, and style them through PELS design tokens.
- Avoid page-local custom design primitives. Shared controls such as chips, cards, segmented choices, switches, buttons, ripples, and elevation should come from Material Web or one shared PELS primitive, not one-off CSS per page.
- Do not import runtime modules from `app.ts`, `drivers/`, `flowCards/`, or `lib/`. Use only `packages/contracts/src/**` and `packages/shared-domain/src/**`.
- Build and test from this package with:
  - `npm run build`
  - `npm run lint`
  - `npm run test`
  - `npm run test:e2e`
- Homey settings UI is mobile-first. Optimize for a max effective width of `480px`, keep `320px` usable, and keep Playwright validation focused on that viewport range.
