# Restore Eagerness

This note tracks the remaining restore-admission concern after the larger 2026 restore-stability
fixes landed.

## What is no longer open

These earlier issues have already been addressed and should not be re-triaged as live unknowns:

- ~~pending-restore power is reserved for recently restored devices~~ — **removed 2026-08-28.**
  The reservation was a second pacing timer competing with the restore cooldown, and the
  measurement that would have released it early is not available: the whole-home meter is a sum,
  so a heater switching off while a charger starts hides the load entirely. Protection is the
  restore cooldown alone (`notes/state-management/actuation-clocks-and-settle.md`)
- target-based restores go through the same restore admission gate as normal restores
- ~~near-zero post-reserve restores are blocked by a hard admission floor~~ — **removed
  2026-09-15.** A flat `RESTORE_ADMISSION_RESERVE_KW` was withheld from every candidate and the
  gate then required the remainder to clear an equally flat `RESTORE_ADMISSION_FLOOR_KW`: 0.5 kW
  of slack charged to every restore of every device, on the chance that some restore somewhere
  might overshoot. That is 100% of a 0.5 kW thermostat's own draw and 17% of a 3 kW charger's, so
  the devices that never overshoot were paying for the ones that do. Three mechanisms already
  answer overshoot with evidence: `computeRestoreBufferKw` scales a buffer to the device's own
  draw, the recent-shed inflation raises the bar for five minutes after a shed, and the
  activation-penalty ladder attributes a MEASURED overshoot to the restores that caused it and
  raises that device's bar exponentially. Admission is now `marginKw >= 0`
- stepped keep-invariant restores are blocked above the lowest non-zero step while any device is
  still shed — EXCEPT for a device with an ACTIVE boost, which bypasses the invariant (boost is
  the user's priority override; 2026-07-05). The restore lane itself asks no further question
  about that boost: it reads `boostActive` and nothing else, so the bypass is unconditional
  *at this layer*. Whether the boost is active at all is decided one layer up, by
  `resolveBoostActive` (`lib/plan/planBoost.ts`), which releases it when the producer confirms
  the device is drawing nothing — a fresh meter reading below the active floor, on a device PELS
  is not itself holding off, with no in-band draw at any rung inside the window. A mid-climb rung
  keeps its boost, because the evidence scan spans every step and the departed rung is still
  live; that is what keeps the 2026-07-05 staircase fixed. Do not re-add a draw-evidence gate
  inside the restore lane: it would ask the same question twice, and the swap-only version that
  used to live there is exactly what this replaced.
- an active stepped boost preserves the highest admitted or observed rung across plan rebuilds;
  the restore lane may continue climbing one admitted rung at a time, but base-plan normalization
  no longer resets the device to its configured low step between those admissions. Normal target
  normalization resumes as soon as boost ends.
- restore power estimation no longer treats zero/low configured values as authoritative when a
  higher measured or planning value is known

## Remaining concern

Field behavior still needs monitoring for this narrower case:

- a device is restored
- measured load ramps late or the whole-home sample is stale
- PELS admits the next restore before the first device's real draw is fully visible
- the second restore contributes to an overshoot

This is no longer the broad "restore logic is wrong" problem from the earlier investigation. It
is now a calibration and observability problem around delayed power visibility.

Per-device-per-step calibration (`lib/device/devicePowerCalibration.ts`) is one of the signals
available to the restore-admission path: stepped-load helpers consult the conservative-high
admission view (`max(observed, nameplate)`) when sizing restore deltas, so a device that
historically draws more than its nameplate at a given step reserves more headroom on restore.
Calibration does not directly address the "second restore admitted before the first ramps"
race — admission still uses the nameplate-bounded estimate during the warmup window — but it
narrows the upper-bound estimate as evidence accrues.

## Bounded Restore Batching

PELS may admit more than one previously-shed device to `keep` in a single planning cycle only
when the normal restore gates are otherwise clear. This is intended for recovery after a
capacity limit or margin increase, where many devices can be shed despite abundant headroom.

Batching is intentionally narrow:

- the first restore still follows the normal admission rule
- at most three devices can be admitted from the shed posture in one cycle, counting binary and
  stepped transitions together. Once a non-empty plan has established membership history, a
  device missing from the previous plan starts in that posture; a device the previous plan kept
  does not become a restore candidate from its observed off state. Before that first plan, only
  observed-off devices use the initial start-admission path; already-running loads are not treated
  as restorations just because no plan history exists yet
- cumulative admitted restore need is capped at 50% of the starting available headroom
- startup stabilization, shortfall, overshoot, shed cooldown, and restore cooldown keep the
  previous one-at-a-time behavior
- the budget-exempt restore lane (admissions while shedding stays latched on a budget-driven
  overshoot) is always one-at-a-time: its batch state is explicitly disabled, independent of the
  overshoot flag, so the hysteresis band cannot re-enable continuation there
- target-based restores and active stepped-load step-ups remain conservative unless separately
  proven safe
- a previously-shed stepped load restoring from `off` to its lowest active step follows normal
  cross-device priority ordering and consumes one slot in the shared three-device cap; the
  conservative stepped gate still applies to later step-ups while other devices remain shed,
  unless the device has an active boost (invariant bypass, 2026-07-05; headroom admission and
  attempt-hold still gate each rung). "Active" is the upstream decision described above — a boost
  released for confirmed no-draw is not active, and the device is then subject to the invariant
  like any other

After a batch, the normal meter-settling / restore-cooldown behavior still blocks the next cycle.

## Questions still worth answering

1. Is the remaining overshoot pattern primarily stale whole-home power, device-level ramp delay,
   or both?
2. Is the per-device restore buffer (`clamp(0.1·P + 0.1, 0.2, 0.6)`) still too optimistic for
   common high-draw heating elements? It is the only slack applied to a FIRST restore — before the
   recent-shed inflation or the activation-penalty ladder have anything to act on. It is not the
   only thing standing between a restore and a re-shed: the shedding latch will not release until
   capacity headroom clears `SHEDDING_CLEAR_THRESHOLD_KW` (0.4 kW), a freshly restored device is
   deprioritised from shedding for `RECENT_RESTORE_SHED_GRACE_MS` (3 min) unless the deficit
   exceeds `RECENT_RESTORE_OVERSHOOT_BYPASS_KW`, and the restore cooldown doubles 60 → 300 s on any
   instability inside 5 minutes of a restore.
3. Do the existing structured events make it obvious which restore was admitted on stale data?

## Evidence to collect when it happens

- `restore_admitted` fields including `estimatedPowerKw`, `powerSource`, `availableKw`,
  `neededKw`, and `marginKw`. (`reserveKw` and `postReserveMarginKw` went with the flat
  admission slack, removed 2026-09-15; `pendingRestoreKw` and `postReserveSlackKw` went with the
  pending-restore reservation, removed 2026-08-28 —
  `notes/state-management/actuation-clocks-and-settle.md`.)
- the next few whole-home power samples and device-level power observations
- whether the rebuild that admitted the restore was triggered by `power_delta`, `max_interval`,
  startup/bootstrap, or another non-power reason
- whether the overshoot attribution points back to a recently restored device inside the expected
  confirmation window
- `overshoot_entered` fields including `reasonCode`, `lastPlanBuildAgeMs`,
  `lastPowerUpdateAgeMs`, `overshootPlanAgeMs`, `overshootPowerSampleAgeMs`,
  `overshootTopControlledContributors`, and `overshootTopUncontrolledContributors`
- `overshoot_cleared` fields including `durationMs`, `lastPlanBuildAgeMs`, and
  `lastPowerUpdateAgeMs`, to distinguish stale lifecycle state from genuine slow recovery

## Useful regression coverage

- delayed-ramp restore sequences where the first restored device does not show full draw
  immediately
- back-to-back restore attempts with slightly stale headroom data
- back-to-back restores where the restore cooldown is the only thing pacing them, since the
  pending-restore reservation is gone
