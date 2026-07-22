# Multi-home model — design-of-record (v1)

The home model that underpins the user-facing **Multiple meters** feature: one
Homey Pro, several whole-home meters, each metering a distinct part of the home
(a rental unit, an annex, a cabin). This note is the contributor-facing
invariants record for the whole v1 train (R1–R8 + R7b per-home bundles + U1/U3
UI). The feature is now generally available; the hidden `multi_home_enabled`
release flag that formerly gated it has been removed. For the first
behavior-affecting slice — main becoming the membership complement — see
[multi-home-complement](multi-home-complement.md);
for the user-facing vocabulary, see the "Multiple meters vocabulary" section of
[ui-terminology](ui-terminology.md).

## The home identity

- A **home** is `{homeId, name, rootZoneId, meterDeviceId}`. Sub-homes (each a
  user-facing "meter area") are explicit and persisted; the **main home is the
  implicit complement** — everything not in a sub-home subtree — and is never
  configured or stored as a home record.
- **`homeId`**: the string `'main'` (the `MAIN_HOME_ID` sentinel) for the
  complement, plus a PELS-generated stable id (`h_` + 8 hex) for each sub-home.
  It is *never* Homey's runtime device uuid — it must survive device
  re-pairing, and it later doubles as a home-device `data.id`. **No `:` is
  allowed in an id** because `:` is the settings-key suffix separator (below).

## Membership resolution (zone rule + pin override)

- A device belongs to the **deepest** sub-home whose root-zone subtree contains
  its Homey zone. Outside every sub-home subtree it belongs to the main home.
- An explicit pin in `device_home_assignments: Record<deviceId, homeId>`
  overrides the zone rule; pinning to `'main'` opts a device out of a
  surrounding sub-home. Absence = follow the zone.
- Degenerate input fails safe to `'main'`: an unknown/missing zone, a zone
  cycle, or a device with no zone all resolve to the main home. Resolution is
  in the **producer** (`lib/home/membership.ts` → `setup/homeMembership.ts`);
  the planner sees only a resolved `homeId` and never branches on the
  provenance (`source: 'zone' | 'pin' | 'fallback'` exists for the UI badge
  only — `'fallback'` marks a fail-safe resolution such as a dangling pin that
  fell back to the zone rule; the control-path `getMembershipMap()`
  deliberately drops `source` entirely).

## Settings key suffixing

- The main home keeps today's **unsuffixed** keys — zero migration, byte-
  identical single-home behavior.
- A sub-home's scalar/state keys are suffixed `<base>:<homeId>` via
  `homeScopedSettingsKey(base, homeId)`, which is the **identity function for
  `'main'`**. Settings dispatch is exact-key, so a parse step ahead of the
  handler table routes a suffixed write to `onHomeScopedSettingChanged(base,
  homeId)` rather than silently no-opping — and, critically, a suffixed
  `power_tracker_state:<id>` write must **not** reload main's tracker.

## Per-home runtime bundles (R7b)

- Each configured sub-home gets its own capacity runtime **bundle** in
  `setup/homeRuntime/` (`homeRuntimeRegistry.ts` keys a `Map<homeId, bundle>`):
  its own suffixed `CapacitySettingsStore`, `CapacityGuard`, `PowerTrackerState`
  (+ suffixed persist), `PlanRebuildScheduler`, `PowerSamplePipeline`, and a
  `PlanEngine`/`PlanService` assembled through a **`HomeScope`** closure bundle.
- Bundles are strictly **capacity-only** by construction — the sub-home
  `HomeScope` hard-wires `getDailyBudgetSnapshot: () => null`,
  `getPriceOptimizationEnabled: () => false`, and a no-op objective decoration,
  and writes a suffixed `pels_status:<id>`. `buildMainHomeScope` reproduces
  today's live-context closures exactly (the identity proof is the untouched
  existing suite).
- **Per-meter sample routing:** one `fetchLivePowerReport` per poll fans out via
  `extractLiveMeterPowerWatts(report, meterId)` — each sub-home's own meter item
  (with a real device id; `totalCumulative` is their sum) into that bundle's
  pipeline. Realtime events route by `homeMembership.getHomeIdForDevice`. This
  is why sub-home power **requires `power_source = homey_energy`**: a Flow sample
  carries no meter identity.
- Lifecycle: bundles are (re)built on boot and on a `homes_config` change, and
  torn down in the uninit path; teardown fences in-flight work and nulls the
  actuator seam so a late callback cannot actuate after ownership moved.

## v1 scope boundary (do not widen without a scope decision)

Per-meter: **hard cap, safety margin, dry-run (control on/off), device
priorities, real-time limit/resume.** These are genuinely per-meter.

Whole-home / main-only, on purpose: **daily budget, price optimization, smart
tasks, operating mode.** Budget and price are about home-wide energy/cost, not a
single meter; R8 blocks smart-task admission on a sub-home device: the
create/edit/Flow write refuses with the typed **rejection reason**
`device_in_sub_home` (`lib/objectives/deferredObjectives/objectiveWrite.ts`).
A distinct **decoration diagnostic**, `objective_device_in_sub_home`
(`diagnosticTypes.ts`), marks an existing task whose device later moved into a
meter area — do not conflate the two codes. Flow cards + widgets remain
whole-home. The home device driver + device-scoped flow cards are a deferred
follow-up train.

## Availability (generally available)

Multi-home is always on. It ships dormant by data, not by a flag: with no
`homes_config` set, membership resolves every device to main, the registry
reconciles to zero bundles, and the "Multiple meters" panel shows only its
empty-state explainer — so a single-meter home is behaviourally unchanged. The
feature "activates" the moment the owner creates a meter area. Historically, a
hidden `multi_home_enabled` flag gated all of this for staged releases; it and
its reader (`setup/multiHomeFlag.ts`) have been removed, so membership always
recomputes, the registry always reconciles from `homes_config`, `ui_homes`
always serves the full payload, and the nav card + per-home Limits switcher are
always present (the switcher appears once at least one meter area exists).

## Reference implementations

| Concern | File |
|---|---|
| Membership resolver (pure) | `lib/home/membership.ts` |
| Membership service (cache, recompute triggers) | `setup/homeMembership.ts` |
| Complement filter (one seam, provenance-free) | `filterDevicesForHome` in `setup/homeMembership.ts` |
| Per-home bundle registry + lifecycle | `setup/homeRuntime/homeRuntimeRegistry.ts` |
| HomeScope (main vs sub) | `setup/homeRuntime/homeScope.ts` |
| Per-meter live read | `extractLiveMeterPowerWatts` (power source) |
| Suffixed key helper (`homeScopedSettingsKey`) | `lib/utils/settingsKeys.ts` |
| Read/write UI seam | `setup/settingsUiApi.ts` |
