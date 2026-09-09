# PELS owns a managed thermostat's setpoint

**Default ownership, 2026-08-26; explicit opt-in extended 2026-09-08.**
The per-device **Temperature control** choice selects one of three policies:

- **Use mode target** (default): external setpoint changes are observations; PELS
  continues to apply the current mode target with its normal adjustments.
- **Leave temperature to you** (formerly "Disable temperature control"):
  `projectTemperatureDeniedDevice` strips the target axis. PELS makes no setpoint
  writes, while binary and stepped control remain available.
- **Update mode target**: an admitted external setpoint transition updates this
  device's target in the active mode of its owning home. The selected temperature is literal: saved mode targets remain writable, including
  when switching modes, but price/solar offsets and fixed-temperature limiting
  are not applied. Saved adjustment preferences are preserved for switching back.
  Binary and stepped limiting remain available; a temperature-only device has no
  remaining limiting control. Temperature Smart tasks require full temperature
  control and cannot be created with this policy.

**Observation → mode owner → next meter-driven plan.** `TemperatureAdjustmentObserver`
classifies command echoes in the device observation path, with no plan comparison.
`ObservedTemperatureModeUpdates` applies the opt-in and persists the mode edit.
The executor and drift detector never edit a mode. A live write fence accepts only
the normalized saved target under Update mode target, so a queued price/limit
command cannot overwrite a newly chosen temperature after the policy changes. The SDK settings
notifications for these edits (immediate or delayed) are consumed without a rebuild; the mode caches reload
and the next reading decides from the new target. Ordinary UI/Flow mode edits
keep their existing settings-triggered rebuild behavior.

A new `temperature_control_modes` entry overrides the legacy disable boolean for
that device. Without an entry, the old toggle retains its meaning. The shared key
owner is `packages/shared-domain/src/settings/temperatureControl.ts`.

Only changed, already-observed, finite target values from the live observation
path qualify. Initial snapshots and regained temperature facets are not user
intent. The producer records normalized PELS writes before the SDK call, including
calls whose outcome fails, since rejection does not prove a device never acted.
The latest commanded value stays attributable; superseded values remain
attributable for two minutes after supersession. Matching values are conservatively
ignored, including a user deliberately choosing that same value. Homey does not
identify the actor: other apps and Flows qualify as external changes too. A
superseded echo arriving beyond that window cannot be distinguished from a new
external adjustment. Command attribution is in-memory and starts afresh at boot.

Ownership/catalog unavailability skips the edit rather than writing another
home's mode or replacing a partial catalog. Each synchronous edit resolves its
home and mode before persistence; there is no delayed edit queue that could
silently retarget it after a mode switch.

The settings UI reads the observer snapshot, where the device is still
`deviceType: 'temperature'`. That is deliberate and is not the same question:
`supportsTemperatureDevice` asks whether the device HAS a setpoint (which is what
renders the choice, and the saved targets under it), while
`supportsTemperatureControlDevice` asks whether PELS may write it.

("Leave off until turned on again" honours an external OFF, but that is the
binary axis and a separate per-device opt-in. It says nothing about setpoints.)

## Why

There remains one baseline: the saved mode target. Updating that baseline must
not bypass a capacity decision or introduce another target for the planner to
arbitrate against. Normal mode ownership needs no special revert path: an
observed change is an ordinary input to the next rebuild, and the executor
applies the desired target whenever observed and desired disagree. Correction is
a normal convergence.

## What PELS owns it *at*

The per-mode target — one per (home, mode, device). **"This device has no target
for this mode" is not a state the planner can be in.**
`persistFilledModeTargets` (`setup/appDeviceSupport.ts`) runs on the settings
refresh, before the first plan of that cycle, and writes an entry for every
device the planner will plan — seeded from the device's own current setpoint, so
adopting it moves nothing the owner can see. Candidacy is the PLANNED set
(`managed !== false`), because that is what the planner plans; capacity control
being off is about shedding and does not hand the setpoint back.

Writing it down is what makes ownership durable rather than nominal: a setpoint
re-derived from the device on every boot is followed, not owned.

## There is nothing else to remember

**The value PELS restores a device to is the target for the current mode.** It
is not a memory of what the device was set to before PELS lowered it, and PELS
keeps no such memory — no pre-shed value, no "what did I lower this from", no
per-device restore record of any kind.

This is the rule to check a design against, because the alternative is easy to
reinvent. It has been built once already: a persisted pre-shed anchor
(`lib/plan/preShedAnchor.ts` + a settings-backed adapter, 2026-08-25, removed
2026-08-27) recorded the setpoint each shed lowered a device FROM, so a release
had something to aim for. It existed only because a device could reach a plan
build with no target for its mode — and that is no longer a state, so the record
had nothing left to say. Restoring is reading the mode, not consulting a note.

The pull to rebuild it comes from asking "what if the mode's target is missing
or wrong?". Answer that where the target is produced — the mode catalog and the
pass that keeps it complete — never by adding a second place that also knows
what a device should be set to. Two sources of a device's intended setpoint is
the problem, not the safety net.

## Consequences to keep true

- **Seed candidacy is the planned set, not the opted-in set.** Narrowing it to
  `managed === true` excluded every implicitly-managed device; narrowing it to
  `controllable === true` additionally excluded price-only thermostats, which
  silently disabled price optimization for them (a price delta modulates a
  configured mode target and nothing else).
- **A reviewer report shaped "the owner changed the setpoint mid-shed, so PELS
  later restores a stale value" depends on the selected policy.** Under the
  default it is drift. Under Update mode target, an admitted external adjustment
  must update the saved mode target before the next plan. The next plan may limit
  power using another control axis, but never changes the temperature for limiting.
