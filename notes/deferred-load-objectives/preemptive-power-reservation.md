# Preemptive power reservation

Design of record for the smart-task **"pause lower-priority devices"** permission
(`pauseLowerPriorityDevices`). Implementation: `lib/plan/admission/headroomReserve.ts`.

## The problem it exists to solve

A device with a large minimum step needs a *contiguous block* of power to start at all. An EV
charger cannot begin at 200 W; it begins at its lowest current or not at all. In a home full of
small loads cycling on their own thermostats, the available power wobbles constantly, and a
top-priority device with a fully-reserved smart task can be out-competed roughly 2:1 by
lower-priority thermostats: every time enough power gathers for its block, something small has
already taken a slice of it.

PELS's ordinary reservation is *reactive*. The swap path (`lib/plan/restore/swap.ts`) frees power
by pausing a lower-priority device that is **drawing** — correctly so, since pausing a device
drawing nothing frees nothing. But that means it can do nothing about a device that is idle right
now and will switch itself on in two minutes, straight into the block being assembled.

This was first written down in commit `18296a370` (2026-07-01) and, until this note, nowhere else.

## What the mechanism is

While a granted task is in a planned hour and its device has not started, the device holds back
the power it needs to reach its **lowest active step** from the admission of **lower-priority**
devices. Concretely: at restore admission, a candidate's available power is the raw figure minus
every reserve held by a strictly more important device (`resolveReserveAdmission` /
`resolveClaimedReserveKw`, `lib/plan/admission/headroomReserve.ts`).

It **sheds nobody and issues no writes.** A device that is already off simply is not resumed yet.
A device that is running keeps running.

## The boundaries, and why each one is there

**Step 1 only.** The reserve is exactly the lowest active step's power — never the next step, the
target step, or nameplate. It exists to get the device *started*. Once the device is on step 1 the
reserve is gone and it climbs the ladder under ordinary admission, the stepped shed invariant, and
boost (which is the separate `limit lower-priority devices` permission) like anything else. A
reservation that survived into a step-up would be charging other devices for a climb, which is not
what the permission promises.

**Release on confirmed step evidence, not on draw.** For a stepped device the reserve dies when
`reportedStepId` confirms step 1 or above. A draw threshold is wrong at this boundary: a charger
correctly sitting on 6 A while it ramps, or a heater holding its lowest element at setpoint, reads
well below half its nameplate step, and a draw-only test would keep the reserve alive long after
the device had started. Same rule and rationale as `isSwapTargetComplete`
(`lib/plan/swap/completion.ts`): decide from confirmed evidence, never the planner-effective
`selectedStepId`.

Two further release paths sit alongside it, both of which can only release EARLIER, never later: a
device whose binary control is confirmed on has started by definition, and a measured draw at or
above half the startup figure means the same. The draw path is the only signal a device with no
step axis has. The binary path matters more than it looks: without it any duty-cycling load —
a water heater PELS keeps on, drawing its element power and then nothing at setpoint — would
alternate between satisfied and waiting forever, re-arming the bound on every cycle so it never
elapsed.

**One shot per grant.** Once a device has been seen to start, the release is *latched* for as long
as the permission remains — it is not re-evaluated from instantaneous draw. This matters for any
device whose only start evidence is draw: a target-only thermostat has no binary handle and no step
axis, so without the latch it would alternate between satisfied and waiting on every element duty
cycle, minting a fresh bound each time and holding lower-priority devices out for the whole window.
Get the device going, then stay out of the way.

**Bounded lifetime.** A reserve lapses after `HEADROOM_RESERVE_MAX_MS` (15 min). Without it, a
priority-2 device waiting behind an immovable priority-1 load would hold priority-3+ devices out of
admission forever for a start that is never coming.

**The claim is an amount kept free, not a ceiling.** The subtraction that produces effective
headroom is signed and unclamped. Clamping it at zero inverts when available power is already
negative (a large pending restore does that), and capping the claim at available power would let a
swap free just enough for itself and consume the unaccounted remainder of the promised block — in
exactly the tight-power case the feature exists for. A swap must free enough for the candidate AND
the whole reservation.

**Only lower-priority devices are constrained.** Active devices in one home have unique relative
ranks, so every other device is either lower or higher priority. The strict comparison remains
defensive for legacy inputs; a more important device ignores the reserve entirely. Reserves from
several devices sum, because two devices each waiting for their own block each need that block.

**No reserve for a device that cannot start.** An external off-hold, an unavailable device, or one
that is not commandable gets none: the cost lands entirely on other devices and buys nothing.

## Why this shape and not the original one

The first implementation (`lib/plan/shedding/pauseHold.ts`, deleted) achieved the same goal by
adding every lower-priority managed device to the plan's shed set — explicitly *"including idle
ones"*. Three things were wrong with it.

1. **It shed devices for zero relief.** Turning off a device already drawing 0 W frees nothing but
   still costs a write, and the device then has to fight back through restore cooldown and backoff.
   Observed in production on 2026-07-31 at 22:04: 2.48 kW available, ten controlled devices at zero
   draw, twelve devices marked limited, ten writes issued. `resolvePauseHold` had a feasibility-lift
   and a release-on-active gate but never asked the one question that mattered — *could the device
   already start unaided?*
2. **Priority asymmetry.** A priority-2 reserver held priority-3+ off while priority-1 kept
   consuming the block. The hold damaged devices that could not help.
3. **It was a smart-task-shaped selection lane inside `lib/plan`,** which `lib/plan/AGENTS.md`
   declares smart-task-agnostic. The import ban was satisfied because the seam passes flat bits, so
   nothing failed — and `notes/starvation/README.md` ended up writing the lane an exemption instead
   of the lane not being built.

**The line that makes the current shape legitimate is mechanical, not causal.** Be honest about
what it is not: for a device that *would* have been resumed this cycle, the observable outcome of a
reservation is the same as a shed. It is classified as a hold (`HOLD_REASON_CODES`) and, since
2026-08-08, it **runs the starvation clock** — `reservedForStart` is a counting cause, because PELS
is the reason the held device is down (`notes/starvation/README.md`). It used to pause the clock on
the grounds that the reserve is bounded by `HEADROOM_RESERVE_MAX_MS`; that bound is a property of
the mechanism, not something the held device experiences, and the reserve's 15-minute ceiling is
exactly the starvation entry delay, so a maximally long reservation now sits right at the entry
boundary. The code says so. Claiming the reserve "does not affect other devices" would be a
rationalisation.

What is actually different is the mechanism, and it is checkable:

- the reserve never touches `shedSet`, and never runs during the shedding pass — it is resolved
  once inside `applyRestorePlan`;
- the binary path can only reach a candidate that is **observed off**
  (`resolveRestoreObservedState === 'off'`), so it structurally cannot turn a running device off.
  `pauseHold` could, and did — that is the falsifiable difference;
- no write is issued: `reservedForStart` is in `RESTORE_ADMISSION_HOLD_REASON_CODES`, so the
  executor builds no intent for it at all (pinned by `test/unit/planDecisionSemantics.test.ts`);
- the affected device's cooldown and backoff state machines are never disturbed — `lastDeviceShedMs`
  is written by the executor on actuation only, and no actuation occurs;
- there was exact shipped precedent — `reserveHeadroomForPendingRestores` let one device's
  in-flight restore shrink every other device's available power. **It was removed on 2026-08-28**
  (`notes/state-management/actuation-clocks-and-settle.md`), so cite it as prior art for the
  SHAPE only, not as a live mechanism. Note why it went, because the reasoning applies here too:
  its release depended on seeing the load on the whole-home meter, and that meter is a sum which
  cannot attribute. A reservation whose release cannot be evidenced becomes a second, worse-sized
  pacing timer beside the cooldown.

The stand-down does set `plannedState: 'shed'` on the device, through the shared
`rejectBinaryRestore` path every restore reject uses. That records "not resumed" for a device that
is already off; it is not a selection decision, and no intent follows it. The shed-temperature
hold lane (`resolveRestoreDecision` in `lib/plan/planReasonsRestoreGating.ts`) runs the same
reserve admission for a setpoint-shed device that is observed ON: the hold re-asserts the shed
floor the device already sits at, so in the steady state no new write follows there either.

So the rule to carry forward is: **a decoration may subtract from a figure admission already
consumes; it may never add a device to `shedSet`, and never produce an actuation intent.**

## Known limit

Reservation stops **PELS** from resuming devices into the block. It cannot stop a managed thermostat
sitting in `plannedState: 'keep'` from switching itself on under its own thermostatic control —
that would require shedding it, which is the behaviour being removed. So the share of the original
out-competition caused by autonomous cycling is not recovered here.

When that happens the device is, by definition, *drawing*, which is precisely the case the reactive
swap path already handles with genuine relief. The two compose: reservation prevents PELS from
giving the block away, swap takes it back from whoever actually took it.
