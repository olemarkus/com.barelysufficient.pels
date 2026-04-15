# Restore Eagerness

This note tracks the remaining restore-admission concern after the larger 2026 restore-stability
fixes landed.

## What is no longer open

These earlier issues have already been addressed and should not be re-triaged as live unknowns:

- pending-restore power is now reserved for recently restored devices
- target-based restores go through the same restore admission gate as normal restores
- near-zero post-reserve restores are blocked by a hard admission floor
- stepped keep-invariant restores are blocked above the lowest non-zero step while any device is
  still shed
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

## Questions still worth answering

1. Is the remaining overshoot pattern primarily stale whole-home power, device-level ramp delay,
   or both?
2. Is the current admission reserve still too optimistic for common high-draw heating elements?
3. Do the existing structured events make it obvious which restore was admitted on stale data?

## Evidence to collect when it happens

- `restore_admitted` fields including `estimatedPowerKw`, `powerSource`, `availableKw`,
  `pendingRestoreKw`, `reserveKw`, and `postReserveSlackKw`
- the next few whole-home power samples and device-level power observations
- whether the rebuild that admitted the restore was triggered by `power_delta`, `max_interval`,
  startup/bootstrap, or another non-power reason
- whether the overshoot attribution points back to a recently restored device inside the expected
  confirmation window

## Useful regression coverage

- delayed-ramp restore sequences where the first restored device does not show full draw
  immediately
- back-to-back restore attempts with slightly stale headroom data
- cases where the pending-restore reservation is accurate enough to block the second restore
- cases where a larger reserve or confirmation threshold would have changed the decision
