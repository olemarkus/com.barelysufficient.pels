# One settings key, one reader/writer

**Every persisted settings key has exactly one module that knows what its bytes
mean.**

This note governs keys **both sides read**. A key only the runtime reads belongs
wholly to its `lib/` module, which reads it through a `SettingsPort` handed over
by `setup/` — see `setup/AGENTS.md` § "No domain logic". Either way the wiring
layer never reads a key itself. That module owns the read policy (how a malformed or partial value is
interpreted) and the write policy (what may be persisted at all). Callers own
their transport and nothing else.

Owners of keys read by both sides live in `packages/shared-domain/src/settings/`:
the Node runtime reads through `homey.settings`, and the browser settings UI
reads the same bytes over the Homey API bridge. The shared interpretation must
execute in both environments. Browser compatibility or reuse by several backend
modules alone does not qualify code for shared-domain, nor does a possible future
UI reader. A runtime-only key stays with its owning `lib/` module; a UI-only key
stays with its browser consumer. This placement is an ownership review decision,
not something the dependency checks establish (see `docs/architecture.md`
§ "Shared-domain ownership").

## What the owner does and does not hold

**Holds** — the value's type; the read policy applied to a raw `unknown`; the
write policy, as a predicate or an assertion.

**Does not hold** — the transport (`settings.get`/`set` vs the async bridge), or
the meaning of *absence*. Absence stays with the caller because the two sides
genuinely differ: the runtime can cross-check `getKeys()` to tell "never
written" from "read failed", and the settings UI cannot. An owner that tried to
answer absence would have to be told the answer anyway.

## Why

`mode_device_targets` is the worked example, and the reason this note exists.
Fifteen files read or wrote that one key, each bringing its own parser — and the
two sides had drifted into **opposite policies for the same bytes**:

| | malformed mode value, e.g. `{ "Home": {...}, "Away": null }` |
|---|---|
| runtime `parseModeDeviceTargets` | coerce `Away` to `{}`, keep the key, carry on |
| settings UI `parseModeNumberMap` | reject the entire catalog, raise "Mode catalog unavailable" |

Nobody chose that. It is what a shared key does when each caller writes its own
parser, and it is invisible until a malformed value actually appears — at which
point the runtime quietly repairs and the UI refuses to load. Neither side is
wrong on its own; there simply was no one place where the question was answered.

## The policies, and the asymmetry between them

Read and write are deliberately not the same test. The reader tolerates what the
writer refuses:

- **Read: sanitize and keep.** A malformed mode value becomes an empty mode
  rather than dropping the key or failing the read. Dropping the key silently
  deletes a mode the owner configured; failing the read stops the pass that
  fills missing targets, and a device with no target is one PELS can shed with
  nothing to restore it to (`notes/temperature-ownership.md`).
- **Write: refuse anything the reader would have to repair.** The store may
  already hold a malformed catalog — written by an older build, by `homey api`,
  or by a partial write — so the reader has no choice. A writer is choosing the
  bytes and has no such excuse.

The asymmetry is the point: tolerate what you are handed, never be the source of
it. With every write path behind the owner, a malformed catalog can only enter
from outside PELS.

## Applying it

- Adding a settings key: give it an owner module before it has two callers.
- Touching a key with scattered parsing: move the meaning into an owner first,
  then migrate the callers, rather than adding one more local parser.
- A caller that needs to know how the bytes are shaped is a caller that should be
  asking the owner.

Keys with owners so far include `mode_aliases`, `mode_device_targets`, `pv_forecast_source`,
`ev_charge_target_settings`,
`homey_price_formula`, `price_scheme` + `powerhour_device_id`, `web_app_cloud_host`,
`daily_diagnostics_report`, `event_diagnostics_reports`, `device_start_policies`
(`deviceStartPolicy.ts`), `device_phase_connections` (`devicePhaseConnections.ts`, read by
`lib/device/deviceControlSettings.ts` and resolved in `lib/phaseFootprint/`), `main_fuse_phase_capabilities` and `main_fuse_phase_meter_device_id` (`mainFusePhaseSource.ts`, read by
`lib/power/mainFusePhaseSource.ts`), `main_fuse_phase_peaks` (runtime-owned, `lib/power/phasePeakLog.ts`, validated
on read), `hard_cap_shortfalls` (runtime-owned, Main home only, `lib/power/hardCapShortfallLog.ts`,
validated on read), `device_phase_learning`
(runtime-owned, validated entry by entry by `parsePhaseLearning` in `lib/phaseFootprint/phaseFootprintLearner.ts`,
written only by that learner through setup's wiring; the settings UI does not write it), `ev_car_associations` (`evCarAssociations.ts`; a charger's entry may carry the standing `assumedCarId`, kept only while it is the sole selected car),
`export_price_source` (`exportPriceSource.ts`), `overshoot_behaviors`
(`shedBehaviors.ts`), and the daily-budget option and switch keys
(`dailyBudgetSettings.ts`), all in `packages/shared-domain/src/settings/`, plus
the keys covered below.
`capacity_follow_month_peak` (home-scopable) belongs to
`packages/shared-domain/src/settings/capacityFollowMonthPeak.ts`: a boolean is the
owner's choice, anything else is malformed, and only a boolean is written. The runtime
reads it with the capacity block (`lib/power/capacitySettingsStore.ts`), which owns
absence: never written is off, and a malformed read carries the last accepted value,
which starts as off in every home, so it never makes the block unavailable. Its
effect is resolved by `lib/power/heldCapacityLimit.ts`, including the expiry used
by Smart Task and battery planning.
The month peak it follows includes a meter's own reported peak, which is held in memory
(`lib/power/meterMonthlyPeak.ts`) and has no settings key.
The settings UI's switch (Main form and meter-area editor) writes it, and a new install
in Belgium has it written on once (`lib/power/capacityMarketDefault.ts`).
`power_history_recovery_request` is the browser's explicit UUID-only command to
the power-history recovery owner. The owner reads the selected Main meter's
hourly Insights history, fills only missing hours of completed days through the
tracker persistence owner, and publishes its outcome on `/ui_power`. Requests
are consumed and never replayed at startup. Existing readings and unreliable
periods remain in place; recovered aggregate meter totals have no device split.

`norway_capacity_choice_request` is the browser's explicit apply/cancel request,
with its type and parser in `packages/shared-domain/src/settings/norwayCapacityChoice.ts`.
The power owner rechecks the current advice before accepting it.
`norway_capacity_choice_state` is runtime-owned by `lib/power/norwayCapacityChoice.ts`;
it holds the accepted monthly Hard cap, the safety margin it was accepted with,
and the last request outcome. The margin reserves planning room below the Hard cap; it is never added to the
remaining-month hourly cap. Editing the margin invalidates the choice. The browser reads
resolved state through the power payload and never writes that key. The normal
`capacity_limit_kw` stays unchanged, and month expiry is resolved at each operational
or planned-period read.

`price_optimization_settings` has one shared parser for device entries, legacy defaults,
and provenance in `packages/shared-domain/src/settings/priceOptimization.ts`.
The same owner defines the adjustment range and stored sign. The runtime and settings
UI retain their accepted map when that parser reports an unavailable read.
`device_power_sources` holds explicit generic setup selections, keyed by device
ID. A socket ID chooses another device's live watts. An entry with value
`null` chooses the device's own reading. The settings UI writes the map, and
`DeviceControlSettings` validates and retains its accepted generation.
`ExternalDevicePower` resolves socket eligibility and links observations.
See [external device power](state-management/external-device-power.md).

`device_power_history_import` carries an explicit request and its correlated
result for importing recent running power from an assigned socket. The
device power history importer consumes live requests and publishes the result.
A request persisted from an earlier run is not replayed.

`device_binary_switches` belongs to DeviceControlSettings. It maps a Homey device
ID to the user's selected Homey on/off capability ID. Removing an entry restores
the device's default binary control. Device transport validates the exact
capability against the accepted read and relates plan intents and write
confirmations to the current binding generation.

`last_resort_devices` is the device-control owner's map of device IDs to positive maximum watts. The Settings UI writes it from device setup. It grants a managed unmetered relay last-resort control and supplies the restore reservation, never measured equipment draw. Adding or removing the setting advances the switch binding revision, so stale commands and OFF ownership cannot survive it. A new maximum keeps the binding and PELS's own OFF; transport refuses a command that carries the old maximum.

`last_resort_external_off_migrated` belongs to the external-off settings owner.
It marks the one-time opt-in and per-device hold migration for existing
last-resort relays. Accepted ON observations clear the seeded holds through the
ordinary external-off sweep. The migration never reads `last_resort_devices`
itself: it takes the configured relays from DeviceControlSettings
(`readConfiguredLastResortDevices`), so a malformed write cannot hide relays the
owner still holds, and it waits while that owner has accepted no read yet.

The three device setup maps (`device_power_sources`, `last_resort_devices`,
`device_binary_switches`) are also pruned by DeviceControlSettings: an entry
keyed by a device missing from Homey's full device list is removed, so a
deleted or re-paired device stops reserving its metering socket. An entry whose
socket is missing stays, so its device keeps showing the saved choice as
unavailable.

`capacity_priorities` belongs to `packages/shared-domain/src/settings/modePriorities.ts`.
Its reader rejects an invalid catalog and retains the last good preferences.
`ModePriorityCatalog` keeps those preferences private and publishes complete orders
for every known device and mode, including new devices and target-only modes.
Consumers receive numeric priorities; they do not distinguish saved and filled ranks.
Filled ranks are temporary: when a home's mode catalog reloads after a fresh read of
this key, its owner (`lib/home/homeModeCatalog.ts`) persists a rank once for every
managed device of that home that has none, after the ranked ones, in the order the
fill already used. It never writes back a retained generation, and it waits until
device ownership is settled.

A home battery has its own place in that order. Unranked, it sorts after every
other unranked device. When it is ranked at the bottom of a mode, a newly ranked
device goes above it, never below; the bottom is found from devices that are
still managed (or batteries), so a stale rank for a device no longer managed
does not move it. A battery the owner moved up is not at the bottom, and new
devices go to the true end. Telling a battery apart needs the device layer's
first full refresh, so the persisted write also waits for the battery set
(`HomeBatteryDevicesRead`); the catalogs reload once when it first resolves,
Main and each meter area (`setup/appInit/wireDeviceTransport.ts`).

`battery_control_devices` (a home battery's Managed toggle) belongs to
`packages/shared-domain/src/settings/batteryControlDevices.ts`: the runtime's
battery control owner reads it through `lib/battery/batteryControlSettings.ts`,
which also owns absence (`getKeys()`: never written means every battery is
managed), and the settings UI's Managed switch writes it. Both reject the whole
map on any non-boolean entry, never sanitize one: dropping a `false` would turn
a battery the owner let go of back on. On a rejected read the runtime keeps the
last map that read cleanly, and fails closed (every battery unmanaged) while no
read ever has; the UI marks the map `unreadable`, shows each battery's Managed
as off, and does not offer the switch until the value is repaired. A battery's
Managed is this key, never `managed_devices`.

A home battery's Power-limit control is its `controllable_devices` entry, read
through its own gate, `packages/shared-domain/src/settings/batteryPowerLimit.ts`
(`isBatteryPowerLimitEnabled`): absent means on (a battery was always limited
before the switch existed), `false` means off. The runtime reads it for the
planner input's storage cluster, never through `isCapacityControlEnabled`, which
vetoes every battery; the settings UI's switch and the capacity-control Flow
cards write it.

`continuous_battery_plan` is owned by `lib/battery/continuousBatteryPlanService.ts`.
`lib/battery/continuousBatteryPlanSettings.ts` resolves genuine absence and
unavailable settings reads; the existing bootstrap uses that same boundary.
The shared schema validates the complete map; any number of batteries may be enabled.
Each entry carries an `exportPolicy` (household-only, or price export with a
0.1 to 100 kW Main-meter ceiling); an entry written before selling existed has
none and resolves to household-only. A present but malformed policy refuses the
map rather than quietly selling nothing.
The UI saves through Homey settings after a fresh complete-map read, preserving
entries for batteries outside the visible roster. A null WebView read requires
an uncached bootstrap read; malformed or unavailable maps refuse the save rather
than falling back to an earlier map. This browser read-modify-write is not atomic
across clients. The owner retains its last accepted map through transient failures.
The existing `ui_devices` response carries the owner's battery plan readout, and
the battery owner's measured round-trip efficiency beside it, which the device page
only offers: Use fills the efficiency field and the owner saves it like any edit.
Each enabled configuration records capacity, reserve, efficiency, wear allowance
and price unit. Enabling checks the current price unit; the runtime also pauses
execution when that unit changes until the allowance is reviewed and saved again.

`ev_charging_session_smoothing` belongs to
`packages/shared-domain/src/settings/evChargingSessionSmoothing.ts`. It is a
per-charger true-only opt-in map; absent entries resolve false. Runtime normalization
retains healthy true entries independently and ignores malformed siblings.
`DeviceControlSettings` keeps the last accepted map through unavailable reads and
forwards the resolved preference to the objective evaluation source. Changing the
setting reloads that owner; it does not force a plan rebuild or change a committed
plan's policy. New plans capture the preference; execution still respects house limits.
The charger page offers the switch only for managed, server-resolved Smart-task
candidates. Saves require a fresh, complete boolean map and preserve sibling entries;
a null WebView read requires an uncached bootstrap owner read. The owner proves
never-written keys with `getKeys()` and refuses an unavailable read. Browser saves
are read-modify-write operations, not atomic across clients.

`ev_smart_task_settings` belongs to DeviceControlSettings. The per-charger map
has a usable car battery capacity and an opt-in home battery discharge pause.
The owner preserves the last map through transient read failures and applies the
two validated fields independently. The charger page saves from a fresh full map,
using the bootstrap owner's read when the WebView cannot prove absence. Tasks
read the resolved settings from their evaluation source.

`ev_charge_target_settings` (a charger's target battery level) belongs to
`packages/shared-domain/src/settings/evChargeTarget.ts`. Its reader sanitizes and
keeps per entry: an active target requires a whole percent in 1..100 and defaults
`chargeBeforeLevelKnown` to `true`. A disabled entry retains only the explicitly
stored preference and carries no target percent. Its writer, the charger page,
uses `parseEvChargeTargetPercent`; a blank or out-of-range field keeps the stored target.
The runtime holds the last map that read as a map (`DeviceControlSettings`); the
getter exposes only active targets to `projectChargeTargetHold`.

`mode_aliases` belongs to `packages/shared-domain/src/settings/modeAliases.ts`.
Runtime and settings UI both lowercase alias keys and ignore malformed entries;
both retain their last-good aliases if the stored value is not a record (the UI
resets to empty aliases when switching to a different home).

`pv_forecast_source` is the cheap case the rule still earns: a flat three-value
union with nothing to sanitize partially, but two callers from day one (the
runtime reader and the settings UI's select), so a second local parser would
have been one drift away from planning and the UI naming different sources for
the same bytes. Its policy is recognise-or-default rather than sanitize-and-keep
— see the module for why defaulting is safe at this particular key.

`price_scheme` and `powerhour_device_id` (owner:
`packages/shared-domain/src/settings/priceScheme.ts`) are the case where the
drift had already happened and stayed harmless by luck. The scheme union was
written out twice — in `lib/price/priceTypes.ts` and again in the settings UI's
`priceSettingsPersistence.ts` — with a recognise-or-default policy in each, and
the two agreed only because nobody had added a fourth source. Adding one
(`powerhour`) would have meant editing two unions that nothing checks against
each other, so the union moved to contracts and the policy here first. The UI
keeps one reading of its own and it is deliberately not this policy: the value
of the `<select>` ELEMENT is not these bytes, so its fallback answers a
different question.

`homey_price_formula` (owner: `lib/price/homeyPriceFormula.ts`) is a
runtime-only key, and the interesting part is its READ policy: neither
sanitize-and-keep nor recognise-or-default, because absence here is not one
state but three. The key mirrors what Homey answered for the owner's price
formula, so the reader must tell "Homey says there is no formula" (a recorded
`{ mathExpression: null }`, which makes raw spot the right price) from "Homey
has never answered us" (no key — we cannot price at all) from "the key is
listed but this read did not produce it" (a transient miss, which settles
nothing). The first two are facts about the home and drive opposite behaviour;
the third must change nothing, so it is told apart with the `getKeys()`
cross-check this note's transport section describes. A stored expression the
evaluator cannot parse is a fourth state, and it is a verdict: the home's real
prices are unknowable and any prices persisted under the old formula are now
wrong. The write policy refuses a failed read outright and skips a write that
would not change the value.

## Which store a key lives in

Part of an owner's contract is *where* the bytes live, and there are two stores
with opposite cost profiles:

`homey_price_formula` sits in `homey.settings` deliberately, and the call is
close enough to state it: it is regenerable from Homey on any successful read,
which by the taxonomy below is the mark of a cache. What settles it the other
way is that PELS refuses to price at all without it, so it is the app's own
mission-critical configuration mirror rather than a cache of fetched data — and
it is one short string, rewritten perhaps once a year, so the write cost the
`/userdata` store exists to avoid does not arise. The prices themselves stay
out: the raw slot payloads of every payload-fed source (Flow, Homey Energy and
Power by the Hour, with their currencies and Power by the Hour's device marker)
and the `combined_prices` built from them live in the price cache.

`web_app_cloud_host` is the same call made the same way: the Homey's own Athom
cloud host, learned from the settings page for the web app
(`packages/shared-domain/src/settings/webAppCloudHost.ts`). It is regenerable,
but it is one short string that changes only if Athom moves the Homey, and in
settings the page writes it with an ordinary `Homey.set` and the bootstrap
carries it, where the userdata store would need an API route of its own
(owner, 2026-10-23: route changes hold up certification and cost calls).

- **`homey.settings`** — configuration and mission-critical state: managed and
  controllable devices, priorities, mode targets and the mode-target ownership
  state (a restore target the app cannot recover is not regenerable), the home
  battery claim records (`battery_control_claim.<deviceId>`, owner
  `lib/battery/batteryClaimStore.ts`: the original mode or command target and
  any hand-back in progress, so a restart can resume the claim or finish
  returning control), device
  control profiles, smart-task definitions, price/budget/EV/weather settings,
  meter and source choice (including which Power by the Hour price device
  prices the home), small live latches. The SDK's `ManagerSettings.set`
  stringifies the value, stringifies the stored value to compare, parses a copy,
  and then ships the **entire settings object** to Homey core over the runner's
  websocket — on every write of any key. Every byte in any key is paid on every
  write of every other key, so this store must stay small and rarely written.
- **`/userdata/pels.sqlite`** (`lib/store/userdataDatabase.ts`) — history,
  learned data and caches: sad if lost, never mission-critical, always
  regenerable. A write costs the bytes written and core never sees it. The
  power tracker's hourly/daily series were the first to move
  (`lib/power/trackerStore.ts`, one row per bucket, diffed writes), the
  weather history second (`lib/weather/weatherHistoryStore.ts`, one row per
  day), the smart-task plan history (`lib/objectives/deferredObjectives/planHistoryStore.ts`,
  one row per run), the device activity history
  (`lib/diagnostics/deviceActivityStore.ts`, one row per observation, up to seven
  days / 100 per device / 1,000 per home), and the device diagnostics
  (`lib/diagnostics/deviceDiagnosticsStateStore.ts`, one row per device-day)
  after them, and the device transport's retained power readings and meter
  anchors (`lib/device/retainedPowerStore.ts`, one row per device, diffed and
  saved at most once a minute) so a restart does not erase the last reading,
  and the price caches (`lib/price/priceCacheStore.ts`, one row per cache: the
  grid tariff one entry per hour, the spot prices with their area, and the
  payload-fed sources' day payloads and markers, and the combined prices built
  from them), and the daily budget's plan and learned profiles
  (`lib/dailyBudget/dailyBudgetStateStore.ts`, one row per field, diffed),
  and the per-step power calibration (`lib/device/devicePowerCalibrationStore.ts`,
  one row per device) and the EV car-link probe's votes, stop samples and
  sessions (`lib/device/evCarLinkStore.ts`, one row per family), and the Flow
  conflicts the built-in controls last accepted
  (`lib/flowApi/acceptedFlowConflictStore.ts`: `native_flow_conflicts` and
  `charging_current_flow_writes`, one row per device, diffed) and the verified
  stepped-load Flow card inventory (`stepped_load_flow_cards`, one accepted
  snapshot, including an empty result), each written through as it changes,
  and the learned power peaks
  (`lib/device/learnedPowerPeakStore.ts`, one row per device, diffed, so a
  peak that moves writes its own row), and the home meter's falls at each
  device's lone switch-offs (`lib/device/homeMeterFallStore.ts`, table
  `device_home_meter_falls`, one row per device, the newest 12 within 30 days), and how long each
  device's lone switch-ons and switch-offs took to show on the home meter
  (`lib/device/meterResponseTimingStore.ts`, table `device_meter_response_timings`, one row per device,
  the newest 12 timed and 12 unanswered per direction within 30 days), and the learned solar forecast's
  generation history (`lib/solar/pvForecastStateStore.ts`, one row per hour, diffed, so the
  five-minute persist writes the hour that changed), and when PELS last controlled each device
  (`lib/plan/lastControlledStore.ts`, one row per home and device, diffed;
  owner, 2026-10-24: actuation history, so it left settings, where one
  transient boot read could wipe it), and the smart-task active plans
  (`lib/objectives/deferredObjectives/activePlanStore.ts`, one row per device,
  diffed; once `deferred_objective_active_plans`, re-plannable state the
  recorder saved on every revision, and the settings UI now hears each save as
  the `deferred_objective_active_plans_updated` push carrying the plans), and
  each home battery's measured round-trip efficiency cycles
  (`setup/appInit/batteryMeterLearning.ts` on the battery owner's row rule,
  one row per battery, written only
  when a cycle is accepted). A cache belongs here whatever its size (owner, 2026-09-27):
  shrinking one does not make it configuration.
- **Nowhere** — a value that is a fact of the running app and nothing else. The
  live status (`PelsStatus`, once the `pels_status` / `pels_status:<homeId>`
  keys) is held in memory by `lib/plan/planStatusRegistry.ts`: every reader —
  the settings-UI API, the headroom widget, the Insights driver — runs in this
  process, the WebView and the driver hear a publish over the
  `plan_status_published` realtime push, and a previous run's status was never
  the right thing to serve. The old keys are unset once at boot and nothing is
  imported.

Owner ruling 2026-09-07. A key that moves is imported ONCE, at boot, on the
first boot that finds the store empty for the home and the legacy value
plausible; the key is then unset and nothing reads it again. A suspect read
leaves the key for the next boot — one transient must never cost a user's
history (`lib/store/legacySettingsImport.ts` holds the rules; each family's
import beside its store hands in what "holds" and "adopt" mean). The learned
solar forecast, the learned power peaks and the last-controlled map also
retry a transient miss during the run while their key is owed, so one missed
read on the upgrade boot does not leave that whole run without the history.
The settings UI reaches history through `api.js` endpoints and the store's own
realtime push, never through a settings key.

### SQLite snapshots

While PELS runs, the database owner keeps up to two daily snapshots in
`/userdata/pels.sqlite.backup-a` and `/userdata/pels.sqlite.backup-b`. A snapshot
can be at most 16 MiB. PELS requires room for the new copy plus 64 MiB of free
space and verifies the copy before replacing a slot. The database, its WAL
and any existing snapshots already count toward used space.

If startup quarantines the live database while snapshots exist, the
quarantined filename ends in `.preserve-backups` and PELS leaves both slots
in place. PELS starts a fresh live database in this case.

An operator with filesystem access can restore a snapshot by stopping PELS,
moving the live database and any `-wal` and `-shm` files out of `/userdata`, and
copying the chosen snapshot to `/userdata/pels.sqlite` with the same owner and
permissions as the live file. Archive the quarantine files, including any
`.preserve-backups` file and its sidecars, outside `/userdata` to resume
rotation. Then start PELS. The snapshots live on the same filesystem as the
database. Stock Homey devices have no PELS restore control.

### Main fuse

`main_fuse_supply` and `main_fuse_amps` belong to
`packages/shared-domain/src/settings/mainFuse.ts`. They are a pair: a supply is usable only with a
valid size, and `off` (or a never-written supply) ignores the size. The runtime store applies the
fuse's total through the grid import limit it hands out, so `grid_import_*` keep holding only what
the owner entered, and the browser never shows the fuse's total as an owner limit.

### Main-home power limit switches

`capacity_enabled`, `grid_import_enabled` and `grid_import_limit_kw` belong to
`packages/shared-domain/src/settings/powerLimits.ts`. The runtime settings store
uses SDK key presence to supply legacy defaults (capacity on, grid off). The one
runtime write is a new install's market default (`lib/power/capacityMarketDefault.ts`):
when the boot found no keys at all and the hub is outside Norway and Belgium, it
writes `capacity_enabled` false once Homey reports the country, unless the owner
has written the switch first. An existing install is not written, unless its
first key read at boot came back empty (the SDK's flake) and it was taken for
new; it then gets its market's default. A listed
malformed flag or an enabled grid limit without a finite positive threshold is
unavailable and preserves the last accepted runtime posture. The browser resolves
the saved switches first, as one posture, and takes the running effective posture
(`capacityScalars`, or its last good copy when that read is unavailable) for a
switch that reads back `null` or a malformed trio: it cannot see the key list, so
a `null` may be a never-written key or a transient miss
(`packages/settings-ui/src/ui/capacitySettingsPersistence.ts`). It uses the shared
threshold validator for edits and for the retained disabled input value. A save
writes thresholds first, then the switch being turned on, then the one being
turned off, and never writes a switch the owner did not change. These keys are
Main-only, not home-scopable. Disabled control axes are `null`, never large
stand-in limits.

Charging setup is backend-owned: `charging_current_control` belongs to
`lib/device/chargingCurrentControl.ts`, and `_homey_flow_api_key` belongs to
`lib/device/transport/homeyActionAccess.ts`, which runs both charger-current and
home-battery app actions with it. The settings UI uses their dedicated
API endpoints and receives resolved setup/access status. The saved key is never
returned by those endpoints or included in the settings bootstrap or diagnostics.

`device_power_control_modes` belongs to
`packages/shared-domain/src/settings/devicePowerControlModes.ts`. It is a map of
device ids to `automatic` or `manual`, written by the settings UI. An unavailable
or malformed runtime read retains the last accepted map. With no explicit entry,
`DeviceControlSettings` keeps an authored target-power model, stepped profile,
or saved charging-current/native-control setup manual; an unconfigured device uses
automatic control. Automatic uses the integration-derived model: a usable published
watt ladder or physical current levels derived from charger settings and limits.
Switching mode retains the manual configuration and its saved current route.
Before the first accepted map, a listed unreadable key or an unavailable key
list keeps control manual. A nullish value authorizes the automatic default
only when the SDK key list confirms that the key was never written. The owner
retries an unresolved read when resolving control for a device.
The legacy target-power, stepped-profile, and charging-current owners likewise
must have accepted a map or confirmed key absence before their empty defaults
can authorize automatic control. Listed unreadable legacy keys keep the device
manual; a valid explicit mode choice still takes precedence.

`ev_car_current_limits` and `ev_charger_current_limits` are settings-UI-authored
maps from car id and charger id, respectively, to `{ minA, maxA }`. The shared
boundary in `packages/shared-domain/src/settings/evChargingCurrentLimits.ts`
accepts ordered whole amps from 6 through 32. Each map retains its own last
accepted state on unreadable reads. Before the first accepted map, only a key
list confirming absence authorizes an empty map; an unread active policy holds
charging off until resolved.

The device owner resolves the live selected car match or explicit confirmation
on every runtime read. A saved car range overrides the charger default. Without
a car override, including an unidentified or non-smart car, the charger default
applies. Without either entry, the existing charging model applies. Limits are
never copied onto held device observations. The command ladder intersects the
active range with the charger's physical capabilities, which a car override
cannot widen. Pausing remains available, including when no active level fits.
`device_target_power_configs` remains the charger's phase/power model; its
persisted shape does not include these current ranges.

## Charging phases

`charging_phase_control` is a settings-UI-authored map keyed by charger id.
`packages/shared-domain/src/settings/chargingPhases.ts` validates the explicit
mode and installation confirmation for both browser and runtime. The device
settings owner retains the last accepted map across unavailable reads; a missing
entry leaves phase control with the charger. The installation mapping remains
in `device_phase_connections`: `three_L1`, `three_L2` and `three_L3` identify the
house phase used during single-phase charging.

`charging_phase_claim.<deviceId>` belongs exclusively to
`lib/chargingPhases/phaseClaimStore.ts`. The owner persists the original setting,
switch history and conservative transition reservation before its first physical
write. Restart recovery returns that setting before admitting another claim.
The UI never authors these records.

## Inverter curtailment

`inverter_curtailment_devices` is an explicit opt-in map owned by
`packages/shared-domain/src/settings/inverterCurtailment.ts`; an absent entry
is off. Runtime reads retain their last accepted map across unavailable reads.
The Electricity prices page writes this key. A later owner mode change in the
inverter app turns its entry off through the runtime settings owner.
The existing UI bootstrap resolves genuine key absence through that same owner;
the device roster rides on `ui_devices`. A UI write merges into a fresh complete
map, and a missing WebView value needs a fresh owner-resolved bootstrap read.

`inverter_curtailment_claim.<deviceId>` belongs to
`lib/executor/inverterClaimStore.ts`. It records the previous production limit
and mode, plus the native binding, before the first command. These small, mission-critical hand-back
records stay in Homey settings until the observer confirms release. A restarted
executor recovers them before admitting new curtailment.
A record without its binding is unreadable and blocks that inverter's recovery.
A hand-back to a prior autonomous mode writes only the mode: its saved setpoint
may be a dormant zero that would cap production while PELS's mode still applies.
After a binding change, PELS restores only watts, using the current range and step
when the saved value no longer fits; it does not write the old mode enum. For a
prior autonomous mode, its accepted native maximum is the production ceiling;
a dormant zero setpoint does not mean that production should stop.

## Device overrides

`lib/overrides/deviceOverrides.ts` owns `device_override.<deviceId>`: one
setting PELS holds on that device until a stored end time (`{ untilMs, setting }`,
parsed by `packages/shared-domain/src/settings/deviceOverrides.ts`). The settings
UI writes the key through the settings bridge. The temporary-temperature Flow
cards and Device insight widget go through the owner. An end time of now ends
it early, and the owner removes a key a day after its override ended. A missing, unreadable or malformed
key means no override. `temporary_temperature_targets` is the older single map,
read until its entries have ended and never written.

## Simple schedules

`lib/schedules/scheduleService.ts` owns named scheduled actions. Each definition
is configured under `schedule.<id>`; `schedule_modes_enabled` and
`schedule_task_enabled.<deviceId>` independently pause groups. The shared parser
in `packages/shared-domain/src/settings/schedules.ts` is used by the settings UI
and runtime. The UI uses the existing settings bridge, and `ui_devices.schedules`
serves the owner's resolved state. A `{ deleted: true }` value is an explicit
UI deletion request: the owner removes the key and its receipt. A listed key
returning null is an unavailable read, never a deletion.

The userdata `schedule_receipts` table stores the latest consumed local occurrence
and its result per schedule. Consumption is committed before the action, so a
restart cannot replay the same occurrence. Startup, edits and enabling schedules
arm future triggers; old triggers are skipped. A trigger may create a fresh Smart
task, start a device override (`{ type: 'override', deviceId, setting, minutes }`,
running from the occurrence, through `lib/overrides/deviceOverrides.ts`) or invoke
a mode change; it never holds a mode, cancels an existing task, or
replaces an open task or an override already in force. Task definitions snapshot their Extra permissions and each
created task carries its source schedule ID/name independently of later edits.

The Settings UI owns `setup_intent`, one optional preference per Homey. It
orders and labels the guided setup choices. The runtime does not read it, and
saving it does not select a device or change a control setting.

Recommendation acknowledgements use `setup_recommendation_dismissals`. The settings UI reads the map through bootstrap. Dismiss and Show again send one card’s change to `/ui_recommendation_acknowledge`, where the runtime merges it with the saved map.
