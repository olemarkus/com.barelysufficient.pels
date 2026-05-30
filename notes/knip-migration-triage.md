# Knip migration — triage state (WIP)

Replacing the custom `scripts/check-dead-code.mjs` (madge + ts-prune) with maintained **knip**.

## Config (done — `knip.json`)
Monorepo: knip auto-detects npm `workspaces`, so each `packages/*` is its own workspace.
`contracts`/`shared-domain` are consumed via deep **relative** imports (`../../packages/contracts/src/…`),
not the `@pels/*` package name, so their workspaces use `entry: ["src/**/*.ts"]` (every file is a
consumable entry). This dropped findings from **67 → 31** unused exports.

## Remaining to reach green (the completion)
1. **Delete 31 genuinely-dead exports** — verified dead via "0 `import` statements" (knip-correct;
   orphaned imperative builders from the JSX consolidation). Notable: `components.ts` keeps the live
   builders (createIconToggle/createToggleGroup/createSwitchField/createDragHandle) but loses 8 dead
   ones (createDeviceRow, createMetaLine, createUsageBar, createCheckboxLabel, createNumberInput,
   createSelectInput, createField, renderList); `dom.ts` loses 6 dead element refs + 1 type; plus
   scattered helpers (loadPriceOptimizationSettings, formatSignedKWh, getCommandableNowReason, …).
2. **Delete 3 dead files**: test/mocks/echarts-subpath-shim.ts, test/utils/loggersMock.ts
   (vitest-env.d.ts is ambient — keep/ignore, verify tsconfig).
3. **Deps**: remove `madge` + `ts-prune` (replaced); `ignoreBinaries: [homey, zsh]`;
   `ignoreDependencies: [@types/homey]` (ambient) + declare/ignore `homey-api`, `playwright`
   (used in scripts). Fix 2 `unresolved imports` in test files (tsconfig resolution) + 9 duplicate
   exports (aliased — alias-collapse or ignore).
4. **Swap**: `deadcode:check` → `knip`; delete `scripts/check-dead-code.mjs`.

Each deletion is import-verified safe; re-run `npx knip` + `npm run build` after each batch.

## Update — discoveries during completion (must inform the careful pass)
- **`echarts-subpath-shim.ts` is NOT dead** — referenced as a vitest `moduleNameMapper`
  resolve path (config, not import). knip false-positive → `ignore` it, don't delete.
  (`loggersMock.ts` IS dead → deleted.)
- **The old script carries a curated "parked" list** (`check-dead-code.mjs`, 40+ entries) of
  exports the team intentionally keeps despite being unimported (e.g. `getCommandableNowReason`
  "parked until chunk-6", the timezone/dateUtils helpers, `DAILY_BUDGET_BREAKDOWN_ENABLED`, many
  `format*`/smart-task helpers). The migration MUST preserve these (mark `@public` JSDoc, which
  knip honours) — NOT delete them.
- So the 31 split: ~5 parked (→ `@public`), ~26 genuinely-dead orphaned builders (→ delete after
  per-symbol config/html/dynamic-ref verification, as several had non-import refs only in the old
  ignore list). 9 duplicate exports are intentional alias pairs (→ disable knip `duplicates` rule
  or `@public`). Do this as a dedicated pass with `npx knip` + `npm run build` + full test suite
  between batches; do not rush.
