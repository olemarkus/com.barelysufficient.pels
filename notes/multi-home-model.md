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
- An explicit meter device id has **exactly one owner across the Main home and
  every meter area**. Main's `null`/Automatic fallback is not an explicit identity
  and remains allowed. That fallback is NOT a combined total: the reader takes the
  first `cumulative` item in the Homey Energy payload
  (`lib/device/managerEnergy.ts`), so it is one unidentified meter which may be a
  superset of Main or an area's own meter. The sampled identity is resolved with
  the reading, rides the sample into the admitted power ingest
  (`setup/powerSamplePipeline.ts` publishes it atomically with the watts), and
  on a proven collision with an area meter fences Main actuation for exactly the
  colliding sample's usable lifetime (`setup/homeMainMeterAuthority.ts`). The
  identity is in-memory only, so a RESTART inside that lifetime is fenced too:
  the tracker reloads durable watts the planner still treats as fresh while no
  ingest of the new process has attested them, and the sampled clause holds Main
  closed until its first admitted sample re-proves provenance (or those restored
  watts age out). Both ownership mutations share the
  typed save endpoint: the UI validates while editing, and the endpoint checks
  a fresh classified homes read before either area or Main-meter persistence,
  so either concurrent write order refuses the second owner. The homes-store
  boundary additionally treats duplicate area ownership as suspect. A legacy,
  stale, or external cross-store collision fails closed at the producer-owned
  Main actuation predicate (plan executor and terminal smart-task actuator)
  until repaired. One physical sample must never drive two independent
  controllers managing different device sets.

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

## Authority and unreliable settings reads

- Raw Homey settings shapes stop at their adapter. In particular,
  `setup/mainMeterSettings.ts` owns `get`/`getKeys`, including
  `undefined`, `null`, an empty key list, malformed values, and thrown SDK
  errors. Every downstream consumer sees only the semantic
  `MainMeterSelection` contract: a resolved explicit id/Automatic selection,
  or `unavailable`. `unavailable` never degrades to Automatic.
- Constructor defaults are not ownership evidence. Main and sub-home control
  stay fenced until both homes and pin stores have each produced a
  non-suspect read; active meter areas additionally require a committed zone
  tree. When Main authority recovers, the runtime builds a fresh plan and
  rechecks authority before reconciliation. An unavailable live Main-meter
  selection or a failed rebuild schedules bounded exponential retry, so
  recovery does not depend on a later meter sample (including in Flow mode).
- A suspect live reload of a suffixed power tracker closes every persistence
  path for that tracker (debounce, prune, rollover, and teardown flush).
  Absence is not positive repair evidence; persistence reopens only after a
  valid present tracker with the runtime's exact meter identity is adopted.
  This prevents an SDK omission from replacing recoverable accounting with
  defaults.

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
- **Meter devices are sources, never controllable loads.** The membership
  producer resolves the explicit Main meter plus every active sub-home meter as
  one source-device set while `power_source = homey_energy`; persisted meter
  selections are dormant while Flow supplies the whole-home sample. The shared
  home-device filter removes the active set from
  every plan and sample-accounting view regardless of zone or pin membership,
  and the final actuator fence rechecks it before every command. The producer
  retains the last-good Main source identity across a transient settings read
  failure, marks source authority unavailable, and every home's filter and
  actuator fail closed until the selection is authoritative again. Smart-task
  candidates, admission, and terminal actuation consume the same source set.
  Smart-task scope distinguishes an active source as a durable exclusion (not
  transiently unavailable): new writes reject it as not planned, while an
  existing task is immediately disarmed at its deadline without issuing a
  terminal device command.
- Lifecycle: bundles are (re)built on boot and on a `homes_config` change, and
  torn down in the uninit path; teardown fences in-flight work and nulls the
  actuator seam so a late callback cannot actuate after ownership moved.
- **Reading a sub-home goes through its own narrow port, not the registry.** The
  registry is a private `AppServiceWiring` field; `AppContext.homeRuntimeRead`
  (`lib/home/homeRuntimeRead.ts`) is the only consumer surface, and it serves
  ONLY already-committed values — the last committed plan snapshot, that home's
  tracker state, the bundle diagnostics. It exposes no device list on purpose:
  the scope's plan-device view seeds observed state and decorates the whole
  snapshot, so serving it would turn a UI poll into a snapshot rebuild. Every
  non-serving case (no such sub-home — main included, it has no bundle — a
  fenced tombstone, or no wired registry) is the single typed `unavailable`
  result, never a fabricated default.

## v1 scope boundary (do not widen without a scope decision)

Per-meter: **hard cap, safety margin, dry-run (control on/off), device
priorities, real-time limit/resume.** These are genuinely per-meter.

**Operating mode is a single global mode, but its per-device targets apply in
EVERY home.** The active mode itself is not yet per-home (a per-home active mode
is a planned follow-up), yet every home's scope binds `getOperatingMode` /
`getModeDeviceTargets` to the live `ctx` reads. This is not a policy choice: the
mode target is the **restore anchor**. Binding it to `{}` for a sub-home made
`resolveTemperatureSeed` fall back to the device's live setpoint, which while
shed IS the shed setpoint, so on release `plannedTarget === currentTarget`, the
executor dropped the write, and an area temperature device stayed cold
indefinitely. Price optimization and surplus absorb stay off for a sub-home
independently, via `getPriceOptimizationSettings: () => ({})` — they only
modulate a `kind: 'mode'` seed and both require a per-device config entry.

Binding those targets live for a sub-home also opened a LOAD-ADDING write, so
one more per-home posture rides alongside them: **`holdsModeTargetRaisesWhile
PowerUnknown`** (sub-homes `true`, main `false`). When it is on and
`context.powerKnown` is false, a load-adding mode-target change is held at the
device's own current setpoint (`applyModeSeedModulation`,
`lib/plan/planDevices.ts`).

A mode target is the one load-adding thing the planner commands as an ordinary
`target_update`, so it consults neither headroom — 0 or negative whenever power
is unknown — nor the restore cooldowns and startup stabilization:
`isTargetRestore` (`lib/executor/executableTargetProjection.ts`) only matches an
observed value equal to the configured shed setpoint, so an 18→22 raise is not a
restore. The hold's shape (rather than blanking `getModeDeviceTargets`) is
load-bearing in these ways:

- **Class-aware direction.** For heat-direction devices a RAISE is held and a
  LOWERING still applies — blanking the map would strand an area consuming
  *more* than the user configured. For cooling-capable classes
  (`isCoolingCapableTemperatureDeviceClass`: heat pump, air conditioning, air
  treatment) BOTH directions are held, because lowering adds compressor load in
  cooling mode and PELS cannot observe which mode a reversible unit is in.
- **Exact observed value, not its normalization.** The hold emits the device's
  reported setpoint verbatim (an off-step 18.6 with a 1° step would otherwise
  round to 19 — a load-adding write the executor could not drop). Planned equals
  observed is by construction the no-op `Object.is(observedValue, desired)`
  drops.
- **Fail closed without an observation.** When the current setpoint is
  unreadable (`buildTargets` omits `value` on a malformed read), no target is
  planned at all: any emitted value would reach the executor with
  `observedValue` undefined, where the no-op fence cannot trip.
- **Honest to the planner.** The mode target stays present, so the device is not
  routed through `resolveMissingModeTargetSeed` — no false `missing_mode_target`
  diagnostics and no grace-window `skip` dropping the device from the plan.
- **Freshness-based, not "never sampled".** `powerKnown` re-closes on every
  stale window, so an area meter that reports once and then dies stops earning
  raises.

Because the hold deliberately lets heat-device lowerings through, those
lowerings must actually reach a silent-meter area: a global `operating_mode` /
`mode_device_targets` write now fans out to every live bundle's planner
(`SettingsHandlerDeps.rebuildHomeRuntimePlansForModeChange` →
`HomeRuntimeRegistry.onModeSettingsChanged`), because a silent meter produces no
power-driven rebuilds and the freshness heartbeat fires at most once per stale
period — without the fan-out a cooler-mode lowering could stay unapplied
indefinitely.

Main binds `false` deliberately. Its unknown-power window is normally the
seconds before the first Homey Energy poll, where an area's unknown-power window lasts as long as its
meter is offline; and main owns settle/dwell machinery for the
power-goes-unknown transition (`lib/plan/planSurplusAbsorb.ts`) that a blanket
clamp would pre-empt. Two exemptions apply to both homes: the deadline floor is
applied after the hold (a smart task's floor is a promise, not opportunistic
load), and a shed setpoint is written regardless, since `planDevicesBase.ts`
overrides `plannedTarget` without consulting the mode map.

Whole-home / main-only, on purpose: **daily budget, price optimization, smart
tasks.** Budget and price are about home-wide energy/cost, not a single meter;
R8 blocks smart-task admission on a sub-home device: the
create/edit/Flow write refuses with the typed **rejection reason**
`device_in_sub_home` (`lib/objectives/deferredObjectives/objectiveWrite.ts`).
A provisional/global Main authority fence is different from durable
relocation: new smart-task promises and writes return retryable unavailable
state, while existing tasks remain enabled and retry terminal work after
authority recovers. The membership-only predicate is used solely for durable
relocation diagnostics/disarm; the reason-bearing authority resolver governs
candidate, preview, create, Flow-write, and final-actuator seams.
A distinct **decoration diagnostic**, `objective_device_in_sub_home`
(`diagnosticTypes.ts`), marks an existing task whose device later moved into a
meter area — do not conflate the two codes. Flow cards + widgets remain
whole-home. The home device driver + device-scoped flow cards are a deferred
follow-up train.

## Availability (generally available)

The Multiple meters UI is always available and there is no current feature
switch. With no `homes_config` set, membership resolves every device to main,
the registry reconciles to zero bundles, and the panel shows only its
empty-state explainer — so a single-meter home is behaviourally unchanged. A
new meter area written by the current UI atomically carries the
`activationVersion` marker and activates its runtime bundle.

Upgrade containment is intentionally stricter than "any populated config is
live." The retired `multi_home_enabled` key remains a read-only evidence seam
in `setup/multiHomeActivation.ts`: a legacy `true` config is migrated to the
atomic activation marker at boot, while an unmarked populated pre-GA config
without that evidence stays runtime-dormant until a successful current UI
upsert marks it. This prevents an old experimental configuration from silently
starting device control on upgrade. Membership still recomputes for
diagnostics, `ui_homes` serves the full payload, and the nav card plus per-home
Limits switcher remain visible (the switcher appears once at least one meter
area exists).

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
| Read/write UI seam | `setup/settingsUiHomesApi.ts` |
