# Settings UI

- This package owns the settings UI source and tests. Work here for UI-only tasks.
- Source files:
  - `src/**` for TypeScript
  - `public/index.html` and `public/style.css` for static assets
  - `dist/` is generated output only
- Use `@material/web` for Material Design primitives when a matching component exists and the component semantics fit the UI state. Register Material Web components centrally, wrap them when needed for Preact, and style them through PELS design tokens.
- Avoid page-local custom design primitives. Shared controls such as chips, cards, segmented choices, switches, buttons, ripples, and elevation should come from Material Web or one shared PELS primitive, not one-off CSS per page.
- Do not import runtime modules from `app.ts`, `drivers/`, `flowCards/`, or `lib/`. Use only `packages/contracts/src/**` and `packages/shared-domain/src/**`.
- **Never hand `getTargetDevices` (`src/ui/devices.ts`) a `homeId`.** It collapses the payload to a flat list, so an `unavailable` scoped read would masquerade as "healthy home, no devices", and it writes the HOME-level `state.hasManagedSolarDevice` / `state.hasExhibitedExport` gates — a resolved sub-home payload would retract those for the whole home (an area without PV hiding the export-price section home-wide). A future scoped devices consumer must resolve through `resolveHomeScopedRead` (`packages/contracts/src/homeScopedRead.ts`) and must never funnel a scoped payload into those two global solar flags. Devices stays badge-grouped and Modes filters the same flat, already-loaded list through the membership roster; neither needs a scoped read.
- Build and test from this package with:
  - `npm run build`
  - `npm run lint`
  - `npm run test`
  - `npm run test:e2e`
  - `npm run test:e2e:capture` for screenshot/documentation capture harnesses excluded from normal E2E
- Homey settings UI is mobile-first. Optimize for a max effective width of `480px`, keep `320px` usable, and keep Playwright validation focused on that viewport range.
