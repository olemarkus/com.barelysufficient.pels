# Knip — config shape and the entry-point trap

`npm run deadcode:check` runs **knip** (it replaced the custom madge + ts-prune
`scripts/check-dead-code.mjs`). The migration is complete; this note records the
two config traps that cost real detection coverage, so nobody re-introduces them.

## Trap 1 — `entry: ["src/**/*.ts"]` disables a whole workspace

`contracts` / `shared-domain` are consumed via deep **relative** imports
(`../../packages/shared-domain/src/…`), not the `@pels/*` package name. The
migration papered over that by declaring every file in those workspaces an entry
point. It looked like progress (findings dropped 67 → 31), but an entry point is
by definition reachable: **knip can never report an unused export in a workspace
whose entry glob matches every file.** `shared-domain` sat in that blind spot
until 2026-08-07, and 21 dead exports had accumulated behind it.

`shared-domain` now declares `"entry": []` — the root workspace's own entries
(runtime, tests, widgets) reach into it through those relative imports, which is
exactly what makes an unreached export a real finding.

**`packages/contracts` still carries the all-files entry glob** and therefore is
still blind; emptying it surfaces ~31 candidates (mostly `settingsKeys` /
`settingsUiApi` constants). That is its own triage pass, not a config tweak.

## Trap 2 — a workspace block that npm doesn't know about is silently ignored

`widgets/*` and `docs` were declared as knip workspaces, but npm workspaces are
`packages/*` only and neither directory has a `package.json`, so knip dropped
both blocks and said so — `widgets/* — Remove from workspaces` — in the
*Configuration hints* section, which is easy to read as cosmetic. Combined with
`!widgets/**` in the root `project`, five widget trees were outside the graph
entirely, so every shared-domain symbol consumed only from a widget would have
reported as a false positive the moment trap 1 was fixed (22 of them did).

Widgets and docs are now plain root-workspace entries
(`widgets/*/src/**/*.ts`, `docs/.vitepress/**/*.{ts,mts}`) with no `!widgets/**`
/ `!docs/**` exclusion, so their imports pull the rest of the graph in.

**Keep the hint list empty.** Both traps announced themselves there. Stale
entries (`vitest-env.d.ts` in `ignore`, `zsh` in `ignoreBinaries`) have been
removed for that reason — a hint section nobody reads is a hint section that
hides the next real defect.

## Suppression mechanism

Knip honours the `@public` JSDoc tag. It is the repo's mechanism for an export
that is deliberately kept without an importer; every use carries a one-line
reason. Current holders:

- `lib/utils/dateUtils.ts`, `lib/utils/settingsKeys.ts`,
  `packages/shared-domain/src/commandableNow.ts` — curated "parked" entries
  inherited from the old `check-dead-code.mjs` list.
- `packages/settings-ui/src/ui/utils.ts` — test-only API.
- `packages/shared-domain/src/price/flowPriceUtils.ts`,
  `packages/shared-domain/src/utils/dateUtils.ts` — **twin files.** Each is a
  hand-maintained copy of a `lib/` module that the settings UI cannot import
  (`.dependency-cruiser.cjs` `no-settings-ui-to-runtime`, severity error). An
  export with no importer in the browser-safe copy is tagged rather than
  deleted, so the two sides stay patchable as one diff. Both files carry a
  `TWIN FILE` header note.

Also still true: `test/mocks/echarts-subpath-shim.ts` is referenced as a vitest
`moduleNameMapper` resolve path, not an import — it stays in `ignore`.
