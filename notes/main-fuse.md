# Main fuse

PELS keeps each phase under the main fuse by treating it as its own budget and limiting, in
priority order, the managed devices that draw on the full phase. A net total cannot do this: solar
exporting on L2 and L3 can hide an overloaded L1.

## Two seams, one owner

- `lib/power/` resolves one `PhaseReading` per net sample. It reaches the planner on
  `MeasuredPower.phase`.
- A dedicated backend module resolves one `PhaseFootprint` per device. It reaches the planner on
  `PlanInputDevice.phaseFootprint`.
- `lib/plan/phase/` holds the shares, the phase shed pass and the phase room used by restore.
  Nothing else computes a phase.

The fuse's total is applied through the grid import limit (the lower of the owner's limit and the
fuse total), so a meter with no phase data and a supply without neutral need no planner change.

## Reading

Net power stays on the configured source. Phases come from the capabilities of the same meter
device (the Homey Energy report's meter item id is the device id). Homey re-dates a capability only
when its value changes, so a phase set is judged by agreement with the net sample, not by age:
within max(500 W, 15 % of the summed absolute phase power), and not frozen while net moves.

A supply without neutral puts a one-phase load on two conductors, so phase protection is for
supplies with neutral. Without neutral PELS holds only the total, sqrt(3) x 230 V x A.

## Limits

The target is 95 % of the fuse with per-phase current and 90 % with power only, because power
understates current at a low power factor.
