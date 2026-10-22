# Settings UI

`packages/settings-ui/src/` owns the browser UI; `dist/` and root `settings/` are generated. UI code consumes `packages/contracts/` and genuine browser/Node logic in `packages/shared-domain/`, never runtime backend modules.

Use Material Web where a component's semantics fit, otherwise reuse a shared PELS primitive and design tokens. See `src/ui/views/AGENTS.md` for view rules and `notes/ui-terminology.md` for wording. Keep 320 px usable in Homey's WebView.

For this project's WebView review, check visible semantics, contrast, keyboard behavior, and accessible names for interactive controls. Ground WebView-specific findings in observed behavior.

`getTargetDevices` in `src/ui/devices.ts` owns home-level solar flags and expects the flat device payload. Do not pass it a `homeId`; use `resolveHomeScopedRead` for a future scoped consumer so an unavailable scoped read cannot masquerade as an empty healthy home.

Navigate with `showTab` (`src/ui/tabNavigation.ts`): a shell page gets its own history entry and `?page=` URL (`src/ui/shellRoutes.ts`), so Back, reload and links reach it. `renderPanel` only shows a panel and is for history-driven rendering (popstate, boot); app-bar back arrows use `navigateBackTo`. A new Settings sub-page goes in `SETTINGS_SUB_PANELS`.

Use focused root npm entrypoints when the changed behavior needs verification. Broad package suites and browser capture belong to a concrete risk or required gate.
