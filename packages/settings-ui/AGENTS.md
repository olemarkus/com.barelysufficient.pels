# Settings UI

- This package owns the settings UI source and tests. Work here for UI-only tasks.
- Source files:
  - `src/**` for TypeScript
  - `public/index.html` and `public/style.css` for static assets
  - `dist/` is generated output only
- Do not import runtime modules from `app.ts`, `drivers/`, `flowCards/`, or `lib/`. Use only `packages/contracts/src/**` and `packages/shared-domain/src/**`.
- Build and test from this package with:
  - `npm run build`
  - `npm run lint`
  - `npm run test`
  - `npm run test:e2e`
- Homey settings UI is mobile-first. Optimize for a max effective width of `480px`, keep `320px` usable, and keep Playwright validation focused on that viewport range.
