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

A battery is only asked to stop charging (`chargeOnly`, bounded by the phase's own draw), never to discharge
for a phase.

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
