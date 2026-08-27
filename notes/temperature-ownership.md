# PELS owns a managed thermostat's setpoint

**Owner ruling, 2026-08-26.** While PELS manages a temperature device, PELS owns
its setpoint. A setpoint someone changes by hand — the thermostat panel, the
Homey device tile, another app or Flow — is *drift*: an ordinary input to the
next rebuild, reconciled by the executor writing PELS's target again. It is
never a competing statement of intent, and nothing in the planner may adopt it
as one.

The single exemption is the per-device **"Disable temperature control"** flag,
and it is represented structurally rather than as a policy branch:
`projectTemperatureDeniedDevice` (`setup/temperatureControlDenial.ts`) strips
the target axis, so a flagged device is not a temperature device to control code
at all. Nothing downstream checks the flag — a device with no setpoint axis has
no setpoint to own.

The settings UI reads the observer snapshot, where the device is still
`deviceType: 'temperature'`. That is deliberate and is not the same question:
`supportsTemperatureDevice` asks whether the device HAS a setpoint (which is what
renders the toggle, and the saved targets under it), while
`supportsTemperatureControlDevice` asks whether PELS may write it.

("Leave off until turned on again" honours an external OFF, but that is the
binary axis and a separate per-device opt-in. It says nothing about setpoints.)

## Why

The alternative gives an owner a way to defeat a capacity decision by nudging a
dial, and gives the planner a second baseline to arbitrate against. The
machinery to avoid that already exists and needs no special revert path: an
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
  later restores a stale value" is rejected on this ruling.** It is drift, by
  definition, and not a defect.
