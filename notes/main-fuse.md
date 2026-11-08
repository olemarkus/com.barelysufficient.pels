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
within max(500 W, 15 % of the summed absolute phase power), and not frozen while net moves. Repeated failed
reads degrade the set, and phases read as `none` when the power source is not Homey Energy, the only one that
reads them.

A supply without neutral puts a one-phase load on two conductors, so phase protection is for
supplies with neutral. Without neutral PELS holds only the total, sqrt(3) x 230 V x A.

## Limits

The target is 95 % of the fuse with per-phase current and 90 % with power only, because power
understates current at a low power factor.

## Device footprint

`lib/phaseFootprint/` resolves each device from the owner's Electrical connection
(`device_phase_connections`), then a charger's own per-phase current (`lib/device/chargerPhaseCurrents.ts`:
three phases over about 1 A is all three, fewer says only that it is not all three), then its EV control
mode, otherwise `unknown`. A charger's "phase 1" need not be the meter's L1, so a one-phase reading is never
turned into a phase name without the owner's say.

PELS also learns a footprint (`phaseFootprintLearner.ts`, fed from each accepted phase sample by setup): for each
of its own commands whose device moved at least 500 W, it compares stable windows before and after, skipping the
samples around the command for meter lag, and drops the step when another PELS command or another managed device's
draw moved in the span. One phase taking at least 70 % of the change with the others little is a vote for that phase;
all three within about a third each is a vote for all three. Five votes with an 80 % majority settle it; three dissenting
votes in a row put it back to unknown. It is kept in the runtime-owned `device_phase_learning` key. The owner's
setting and a live charger reading outrank it. For an EV charger the votes last for the session only and are never
stored, because the phases are the car's. A battery has the Electrical connection row on its own page.

A device waiting for room says so on its card (`Waiting for room on L1`), and a device on an unknown phase offers the
setting as a quiet link to its page. No notification or prompt.

## The shed pass

`lib/plan/phase/phaseShedPass.ts` runs after the scalar selection and merges with it. Scalar shedding is
unchanged; a home with no main fuse never enters the pass (`MeasuredPower.phase` is `off`).

For each breached phase, largest deficit first (deficit = draw - target - credit), candidates come from
the ordinary walk, in the ordinary order, excluding devices the scalar pass already took, self-balancing
devices, and devices whose footprint does not touch the phase. One candidate at a time, each sized for the
remaining deficit divided by its share (a third for a three-phase device, all for a single phase). Known
footprints first. If a deficit stays open, one `unknown` device per cycle may be limited, credited nothing
toward any phase. Relief from a three-phase device also reduces the other phases' deficits by a third.

The pass has no grace: a phase is an instantaneous physical limit, so it ignores `shedActionable`, and the
shedding latch counts a breached phase and any device the pass limited.

The deficit also takes off relief the scalar selection has decided or holds and not delivered, by footprint share,
the larger of it and the pass's own credit per device. A device the scalar pass decided keeps that decision: a
phase decision on it stays for credit only, and the pass does not take it deeper. A stepped device the scalar pass
took at a shallow rung goes no further for a phase this cycle; the next devices on the phase are spent instead,
because pricing the deeper rung net of a rung not yet delivered belongs with `pendingRelief.ts`. The reverse is
left out too: scalar shedding does not credit phase decisions, so a net breach in the same 30 s can limit one
device more than strictly needed.

`physicalLimitBreached` stays capacity and grid only, so a phase breach changes no scalar decision.

A rebuild on a sample the pass already spent on holds its decisions and spends nothing new. An unknown device earns
no credit, so one still responding also holds the next unknown back.

The Overview's "no more devices" line is set only for a phase with nothing limited on it this cycle, no live credit,
and no candidate left.

A battery with a known footprint may discharge to cover its phase, after cutting its charge, bounded by the phase's
import (three times the lowest phase's for a three-phase battery) and by its own ladder and reserve rules. A battery
on an unknown phase only cuts its charge. The pass credits a battery's whole change against the phase; between
cycles its stopped charge and its promised discharge stay separate credits for the scalar side (pending relief and
`StorageShedTerm`). A held discharge steps down only within what its phases can take back, and the hand-back does
not spend it on the phase axis.

## Export overload

A phase exporting past its target is breached in the export direction when the meter reports direction. Loads are
never limited for it. The remedies run in order: a battery discharging on that phase is asked to discharge less
(`phase/phaseExportPass.ts`); what is left goes to a PELS-controlled inverter, past the price-only eligibility, by the
excess (repeated each reading, so a three-phase inverter converges); and surplus loads on that phase see the excess
in the pool, spent between consumers, and held to the import room of the device's other phases. The card and the
Overview name the phase.

Inverter footprints are out of scope, so production is bounded instead: it never drops past three times the excess
from where the breach began, and lowering stops once a real drop did nothing for the phase, because that inverter
does not feed it. A held inverter stays held until the phase has room for what it holds back plus a clear band, and
a battery hand-back from an export hold is gated the same way, by its share of the returning discharge (from the
live continuous plan when there is one).

## Credit

For 30 s after a decision the pass credits undelivered relief, per decision:
`min(reliefKw, max(0, currentDrawKw - (drawAtDecisionKw - reliefKw)))`, times the device's phase share. A
decision with undelivered relief stays in the shed set with its reason and step target, so nothing is lost
between readings. Delivered relief is retired at once, as under grid pressure. The state lives on
`PlanEngineState.phaseShedDecisions`; `pendingRelief.ts` is not involved.

## Restore

The restore ledger gains a `phase` axis next to capacity, grid and budget (`RestoreHeadroomAxes`), and the
inner gates keep their single `availableKw`. `availableFor` narrows by footprint: all three, the lowest phase's
room times three; one phase, that phase; unknown, the lowest phase; self balancing, no constraint. `commit`
spends a third on each phase, all on the phase, or all on every phase. Phase room takes off the clear band
`min(SHEDDING_CLEAR_THRESHOLD_KW, target * 0.1)`, as the grid axis does.

A swap counts a donor only by what it frees on the target's phases, and skips a donor with no share of them,
when those phases are what holds the target. Solar surplus claims are bounded by the device's phase room, so
export on L2 and L3 does not raise a device on L1. Discharge a battery is held at is taken off the phase room by
its footprint, so restore cannot spend it. Battery charge raised from surplus is not bounded by phase: a battery's
footprint is almost always unknown, and bounding it by the lowest phase would stop it storing solar.

A rebuild is triggered by a meter reading only: `phase_pressure` joins the power-sample triggers and is
resolved from the same admitted sample. A device observation never triggers one. A rise under 100 W is not an
escalation, and a phase with nothing left to limit counts as unactionable while no other limit is over.

Import direction only: an exporting phase is never breached, and a current-only meter acts only while the
home as a whole imports.

## Forecasting scope

The battery plan and smart tasks plan against the effective ceiling (`planningPowerCeiling`,
`resolvePlanningCeilingKw`), which includes the fuse total through the grid import limit, so the car and batteries
share a cheap hour in priority order under what the connection carries. Neither forecasts per phase; phases are held
live by the shed pass, the phase room and the export pass above.
