# Multi-home model — design-of-record (v1)

The home model that underpins the user-facing **Multiple meters** feature: one
Homey Pro, several whole-home meters, each metering a distinct part of the home
(a rental unit, an annex, a cabin). This note is the contributor-facing
invariants record for the whole v1 train (R1–R8 + R7b per-home bundles + U1/U3
UI) **and the 2026-07 finishing train** (sampled-meter identity fence, config
invariants, per-home read seam, the global scope bar, per-home Overview/Usage,
home badges, runtime mode pinning, Flow/area mutual exclusion, the aggregate
simulation posture, and the honest scope states). The feature is now generally
available; the hidden `multi_home_enabled` release flag that formerly gated it
has been removed. For the first
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
- **Saved ownership:** an explicit meter device id has exactly one owner across the Main home and
  every meter area. The serialized `ui_homes_save` seam requires an explicit Main meter before an
  area can run and refuses assigning that meter to an area. There is no Automatic selection any
  more — the save seam cannot express one (`set_power_source` persists a named meter or the Flow
  source, nothing else) — so a valid current configuration cannot assign one explicit meter to
  both Main and an area, and "Main with no resolvable meter plus active areas" is only a legacy
  Automatic shape whose owner has not picked a meter yet: Main stays fenced and the no-readings
  banner names the remedy, and nothing rewrites the key on their behalf. Legacy, stale, or
  externally malformed cross-store state
  still fails closed at the producer-owned Main actuation predicate until repaired.
- **Sample provenance:** a Main whole-home sample exists only for the explicitly persisted meter:
  the producer extracts that device's reading from the Homey Energy payload and stamps the sample
  with the configured id — there is no candidate ranking, no session-sticky preference, and no
  ambiguous arm (all retired with the Automatic selection). An unavailable selection or a
  non-finite reading produces no Main sample this poll, and carry-forward holds (a transient miss
  is a no-op). Independently of the saved selection, the identity of every
  admitted sample is resolved with the reading and rides into the power ingest
  (`setup/powerSamplePipeline.ts` publishes it atomically with the watts), and
  a proven collision with an area meter starts a Main-actuation fence episode
  (`setup/homeMainMeterAuthority.ts`). Sample provenance itself is usable only for the sample's
  freshness lifetime, but an observed fence episode stays latched beyond expiry until a later
  admitted sample proves safe provenance and hands control to fresh-plan recovery. This is a defensive
  transport state, not a second valid ownership model: it is reachable while invalid legacy state
  is repaired, when an adapter temporarily misclassifies the configured selection, or when an
  earlier in-flight read lands during that repair. The
  identity is in-memory only, so a restart inside that lifetime is fenced too:
  the tracker reloads durable watts the planner still treats as fresh while no
  ingest of the new process has attested them. That restart fence means only "the current sample's
  provenance did not survive restart"; it is not evidence that Main actually read an area's meter.
  The sampled clause holds Main closed until the first admitted sample re-proves provenance. One
  physical sample must never drive two independent controllers
  managing different device sets.

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
  `MainMeterSelection` contract: a resolved explicit meter id, or
  `unavailable`. Absence is no longer a value — every non-string read
  (including Homey's transient `null`) classifies as `unavailable`, which
  consumers treat as a no-op, never as a different selection. The old P1
  (a transient `null` momentarily read as the stored-Automatic arm) dissolved
  with the Automatic selection itself; nothing in the runtime discriminates
  stored-null any more.
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
- **The settings UI reaches that port through an optional `?homeId=` on
  `ui_plan` / `ui_power` / `ui_devices`** (`setup/settingsUiHomeScope.ts` owns
  the boundary). Three rules hold this together and must not be relaxed:
  - **Absent `homeId` ⇒ the bare URI and the historical payload, byte for
    byte** — no `homeScope` member, and the client's `homeScopedApiUri` maps
    both "no home" and the `'main'` sentinel to the unchanged path. The
    WebView's `apiCache` is keyed by exact URI and ~20 sites invalidate the bare
    path, so a whole-home read that silently became `?homeId=main` would miss
    every one of them and serve a single-home owner a stale Overview with no
    staleness signal. The runtime refuses `?homeId=main` for the same reason,
    so both sides agree the main home *is* the bare URI.
  - **A refused id never becomes a settings key.** `''`, `'main'`, anything
    containing the `':'` key separator, the prototype-colliding keys, and any
    non-string (express hands repeated/bracketed parameters through as arrays
    and objects) are classified before any `homeScopedSettingsKey` call or
    settings read. Refusal is DISTINCT from absence: it answers the empty shape
    plus `homeScope: unavailable`, never a degraded main-home read.
  - **The realtime `plan_updated` / `power_updated` streams stay the main
    home's.** Widening them would repaint Main's Overview from a sub-home's
    device set in a Homey-cached stale WebView. A sub-home's freshness rides
    the suffixed `settings.set` stream (`pels_status:<id>`,
    `power_tracker_state:<id>`) instead, which the change router turns into a
    scoped-only cache sweep. Correspondingly, a main-home push re-seeds the bare
    cache entry and drops the scoped entries it cannot speak for
    (`invalidateApiCacheForScopedHomes`), while every other invalidation of a
    home-scopable read model sweeps bare + scoped together
    (`invalidateApiCacheForAllHomes`).
  - Transport note: a GET query parameter does reach an app API handler. The
    firmware's app-level route passes `args: { query, params, body }` (the same
    shape the widget route uses) and the apps SDK spreads it into the handler
    context — the identical seam `body` already arrives on for `ui_homes_save`.

## v1 scope boundary (do not widen without a scope decision)

Per-meter: **hard cap, safety margin, dry-run (control on/off), device
priorities, real-time limit/resume.** These are genuinely per-meter.

**Modes are independent per home.** Main keeps the historical unsuffixed
`operating_mode`, `mode_aliases`, `capacity_priorities`, and
`mode_device_targets` keys. Each meter area stores the same four values under
`:<homeId>` suffixed keys. A marker-last initialization copies Main's mode
names and aliases, guarantees an area-local `Home` mode, partitions
target/priority entries by authoritative device ownership, starts a new area
in `Home` (or preserves a valid existing area selection), then writes
`mode_catalog_initialized:<homeId>`. Until that marker lands, the area follows
the legacy Main catalog; afterwards Main edits never change the area.

The bundle reads one coherent last-good catalog snapshot, so a transient
settings failure cannot mix one generation's mode with another generation's
targets. Scoped catalog writes reload and rebuild only the owning bundle.
Device-detail target edits, overshoot defaults, and automatic missing-target
seeding resolve through the device's assigned catalog. The Settings page shows
one current-mode selector per home; the Modes page follows the global
**Showing** picker and lists only devices assigned to that home. Mode Flow
cards and the `pels_insights` mode tile remain Main-home-only.

When a temperature device moves between homes, ownership reconciliation copies
its persisted source-mode target into any missing destination-mode entries
before either home's plan rebuilds. It never derives that anchor from the live
setpoint, which may be the temporarily lowered control value. Devices without a
saved target need no transfer; unavailable catalogs or failed writes keep the
membership generation fenced for retry. The last owner whose target transfer
completed is stored separately from current membership. That recovery ledger is
updated only after the destination write succeeds, survives restart between an
ownership commit and target transfer, learns devices that appear after the
initial snapshot, and retains history across transient snapshot absence.

**Mode targets apply in EVERY home.** Every home's scope binds
`getModeDeviceTargets` to its own catalog. This is not a policy choice: the
mode target is the **restore anchor**. Binding it to `{}` for a sub-home made
`modeTargetCFor` (`lib/plan/planBuilder.ts`) fall back to the device's live
setpoint for every device instead of only the boot window, which while
shed IS the shed setpoint, so on release `plannedTarget === currentTarget`, the
executor dropped the write, and an area temperature device stayed cold
indefinitely. Price optimization and surplus absorb stay off for a sub-home independently, via
`getPriceOptimizationSettings: () => ({})`: both require a per-device config
entry, and an empty map has none.

Binding those targets live for a sub-home also opened a LOAD-ADDING write, so
one more per-home posture rides alongside them: **`holdsModeTargetRaisesWhile
PowerUnknown`** (sub-homes `true`, main `false`). When it is on and
`context.planningTotalKw` is `null` — the producer-resolved "no trustworthy
meter total this cycle" — a load-adding mode-target change is held at the
device's own current setpoint (`applyModeSeedModulation`,
`lib/plan/planDevices.ts`). It read the `context.powerKnown` flag until
2026-08-07; the resolved field replaced it so the condition is the absence of
the number rather than a boolean beside one that can disagree with it.

A mode target is the one load-adding thing the planner commands as an ordinary
`target_update`, so it consults neither headroom — 0 or negative whenever power
is unknown — nor the restore cooldowns and startup stabilization:
`lib/executor/executableTargetProjection.ts` advances the restore clocks only for
a write the producer stamped `recordRestoreOnTargetApply`, so an 18→22 raise is
not a restore. The hold's shape (rather than blanking `getModeDeviceTargets`) is
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
- **Honest to the planner.** The hold modulates the resolved mode target rather
  than replacing it, so nothing downstream sees the device as unconfigured. (It
  once mattered more: a device that fell through to the old fallback seed was
  routed past price and surplus modulation entirely. The mode catalog owner now
  answers for every temperature device, so there is no fallback path left to
  fall into — `notes/temperature-ownership.md`.)
- **Freshness-based, not "never sampled".** `planningTotalKw` returns to `null`
  on every stale window, so an area meter that reports once and then dies stops
  earning raises.

Because the hold deliberately lets heat-device lowerings through, those
lowerings must actually reach a silent-meter area: every suffixed area-catalog
write reloads the owning bundle and explicitly rebuilds its planner. A silent
meter produces no power-driven rebuilds and the freshness heartbeat fires at
most once per stale period, so relying on a future sample could leave a
cooler-mode lowering unapplied indefinitely. The Main-catalog fan-out remains
only for a pre-migration area still following Main.

Main binds `false` deliberately. Its unknown-power window is normally the
seconds before the first Homey Energy poll, where an area's unknown-power window lasts as long as its
meter is offline; and main owns settle/dwell machinery for the
power-goes-unknown transition (`lib/plan/planSurplusAbsorb.ts`) that a blanket
clamp would pre-empt. Two exemptions apply to both homes: the deadline floor is
applied after the hold (a smart task's floor is a promise, not opportunistic
load), and a shed setpoint is written regardless, since `planDevicesBase.ts`
overrides `plannedTarget` without consulting the mode map.

Main-home-only, on purpose: **daily budget, price optimization, smart
tasks.** The daily budget is a **Main-home** budget, not a whole-home one:
`createDailyBudgetService` binds Main's tracker and capacity, so once an
explicit Main meter is required the budget plans and measures Main's meter
only. Areas are not aggregated and cannot be — no allocator exists; if
per-area budgets are ever built they will be per-meter budgets, never one
allocated household budget. User-facing copy must say "Main home";
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
meter area — do not conflate the two codes.

**Flow cards follow the refined scope ruling** (a card that can do its job
without the user naming a home keeps working; only cards that would need an
explicit home argument are out of scope): cards that act on a **device** work
wherever that device lives, including inside a meter area; cards about modes,
prices, and the daily budget are app-global settings and behave as before;
cards that read or write a **capacity number** (`Is there enough available
power?`, `Is there available power for device?`, `Set capacity limit`) work
from the Main home. Two triggers are area-aware: `capacity_shortfall` ("Hard
cap breach imminent — manual action needed") and `capacity_shortfall_sustained`
("Hard cap breach imminent for at least… — manual action needed") each carry a
`Home` token whose value is the home's display *name*
(`resolveHomeAreaDisplayName` — `Main home`, the area's own name, or
`Meter area` for a blank name), fired by every home's alert dispatcher. Widgets remain whole-home. The home device
driver + device-scoped flow cards are a deferred follow-up train.

**Flow power source and meter areas are mutually exclusive, both directions**,
enforced at the one serialized `ui_homes_save` seam: saving (creating or
editing) an area is refused while the configured source resolves to Flow (a
Flow sample carries no meter identity), and switching the source to Flow is
refused while areas are RUNNING (a dormant pre-GA config does not block the
switch; activation discrimination is shared with the unresolvable-meter
refusal, `main_meter_required`).
Deleting an area stays allowed on any source, and switching TO Homey Energy
never consults the homes store — the remedy direction must always work. The
settings UI persists the Power source select through the seam (typed refusal →
select rollback + remedy toast), never a bare settings write.

**Aggregate simulation posture.** Main's `capacity_dry_run` and each active
area's `capacity_dry_run:<homeId>` are independent, so the global simulation
banner and the Settings hub chip render the aggregate posture — all live / all
simulating / mixed — resolved in shared-domain (`simulationPosture.ts`) from
Main's flag plus each ACTIVE area's flag. Held pre-GA areas never enter the
posture (their devices still belong to Main); an unresolved flag keeps its
last-good value and an unknown joins no aggregate claim. Main live + a
simulating area gets an area-scoped banner line naming the area and the
Limits & safety page that holds its control; the Main-flag button hides there
because it could not act on the area's flag.

**Changing the whole-home meter selection invalidates the weather
energy-signature backfill scope**: the collector owns a meter-scope signature
and forgets meter-derived state when the scope changes, so the energy
signature is never silently fitted against a meter that no longer measures
what it did (`lib/weather/weatherCollector.ts`).

## Settings-UI scope surfaces (what follows the picker, what says it doesn't)

The shell renders one global home picker (the `Showing` bar, `homeScope.ts`)
once at least one meter area exists in the roster. The bar renders **only on
pages whose content is resolved against the selected home** — a surface earns
it in the same change that teaches it the scope (`SCOPE_AWARE_PANELS`):
**Limits & safety** (per-home cap/margin/control), **Modes** (the selected
home's independent catalog and assigned devices), **Usage** (the selected
home's own tracker history via the scoped `ui_power` read), and **Overview**
(the selected home's committed plan + power via scoped `ui_plan`/`ui_power`).
Scoped surfaces render honest unavailable notices instead of fabricated zeros,
and Main-only elements (smart-task row, daily-budget hero elements) are
omitted under an area, never zeroed.

The **Devices** list stays whole-home and labels each row with a home badge
(`homeBadges.ts`, gated on `runtimeActive`). **Modes** is filtered by the
global picker; priorities are safe to rank from its rendered rows because each
home owns a separate catalog.

Everything else states its scope honestly once meter areas are IN USE (active
roster + `runtimeActive`; a held pre-GA config renders none of these because
its devices still belong to Main). Copy in
`packages/shared-domain/src/homeScopeCopy.ts`:

- **Budget tab** carries a Main-home scope line (the budget is Main's, above).
- **Smart tasks list** carries a Main-only notice (R8 refuses area devices).
- **Device-detail diagnostics + activity log** for an area device render "not
  measured / not recorded for meter areas yet" and skip the fetch — the
  payloads are Main's recorders (`getDeviceDiagnostics: () => undefined` in
  the bundle scope), so an empty answer would read as a healthy device.
- **The Simulation-mode settings page** notes that its switch covers the Main
  home and names each area's own "Control devices in this area" switch under
  Limits & safety — the hub's `Partly on` chip routes there for any split
  posture.

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
diagnostics, `ui_homes` serves the full payload, and the nav card plus the
shell's home scope bar remain visible (the bar appears once at least one meter
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
