# The home battery as a lever

**Status: forward design. No code exists yet.** A battery is observed today and
commanded nowhere: role detection stamps it `managed: true, controllable: false`
structurally at parse, and it is hidden from every picker. This note is the plan
for turning it into a lever the planner may spend, and the ordering and
invariants that plan has to respect. The revisit trigger is at the end.

Code this touches: `lib/device/managerEnergy.ts` (`isHomeBatteryDevice`),
`lib/device/batteryStateProducer.ts`, `lib/actuator/deviceCommand.ts`,
`lib/plan/planSurplusAbsorb.ts`, `lib/plan/shedding/`, `lib/plan/planContext.ts`,
`lib/solar/curtailmentSurplus.ts` (the pattern for a producer-injected term).
Sibling notes: `notes/safe-pace-two-constraints.md` (what the levers are spent
against), `notes/state-management/actuator-write-seam.md` (the one write seam),
`notes/personas.md` § self-consumption maximiser.

## Why this is ours to build

A battery EMS optimises the battery against prices and a forecast. It does not
know what else is running in the house, and it cannot turn anything else down, so
its ceiling protection can only ever be "leave some room and hope". PELS holds
the measured meter, the hard cap, the daily budget, the device priorities and the
deferred objectives, and today it has no access to the one lever that can add or
remove kilowatts on demand. Each half optimises a different fraction of the same
house, and the owner arbitrates by hand.

The promise that follows from joining them is one no battery EMS can make: **the
ceiling holds even when the battery is flat**, because when storage cannot cover
the gap PELS still has every managed load. That is the differentiator, and it is
also the reason the battery must enter as a *lever inside the existing
constraint*, never as a second optimiser bolted alongside it.

## What the platform gives us

Homey standardised the control surface in firmware 12.3, and a battery is a
device whose energy config carries `homeBattery: true`:

| Capability | Meaning |
|---|---|
| `measure_battery` | state of charge, 0-100 % |
| `measure_power` | signed power: positive charging, negative discharging |
| `meter_power.charged` / `meter_power.discharged` | cumulative energy per direction |
| `target_power` | **writable signed setpoint in W**: positive charges, negative discharges, `0` is an active zero-watt hold. Carries `min`/`max`/`step`, and `excludeMin`/`excludeMax` for a battery with a minimum operating power (a value inside that band is coerced to 0) |
| `target_power_mode` | `device` (the battery runs its own optimiser) or `homey` (an outside controller owns the power flow) |

Three control surfaces exist in the field, and the design has to name all three
rather than assume the best one:

1. **Setpoint batteries.** `target_power` is writable. This is the only surface
   PELS should build against. Some vendors gate the write behind a device
   setting (a strategy enum that must first be handed to the API); that is a
   precondition the transport binding owns, in the same place it already owns
   native-versus-Flow routing.
2. **Mode-only batteries.** The app exposes charge/discharge enables, a coarse
   power field, or a mode enum, with no signed setpoint. PELS can express "take
   this much" only approximately here.
3. **Autonomous batteries.** A supplier-run unit that must never be commanded.
   PELS already treats these correctly by treating the battery as a given in the
   balance, and that stays the behaviour.

Homey Energy itself decides nothing about batteries. It monitors, and leaves the
strategy to the vendor app's own firmware mode or to owner-written Flows.

## Canonical names

| Concept | Canonical name | Owner |
|---|---|---|
| Whether this home has a battery PELS may command at all | `storageLeverAvailable` | `lib/battery` |
| The signed setpoint PELS wants, W | `storageSetpointW` | `lib/battery` |
| Charge power the battery could still accept now, kW | `storageChargeCapacityKw` | `lib/battery` |
| Discharge power the battery could still deliver now, kW | `storageDischargeCapacityKw` | `lib/battery` |
| The discharge PELS is counting on this cycle to stay under the pace | `storageReliefKw` | `lib/plan` |
| The share of the surplus pool allocated to charging | `storageAbsorbKw` | `lib/plan` |
| Owner's floor: SoC the lever may not discharge below | `storageReserveSocPct` | shared-domain settings |
| Round-trip loss the lever must beat before it cycles | `storageRoundTripLossPct` | shared-domain settings |

`storage*` rather than `battery*` deliberately: `battery` in this codebase
already means an EV's state of charge in half a dozen places
(`notes/ev-soc-layering.md`), and the two must not collide.

## Where the battery sits in the pipeline

The battery is **not a shed candidate**. Shedding selects devices whose limiting
releases power, and the shedding note's rule is that a device may only be
selected when limiting it releases power. A battery is a source, not a load to
limit, so it enters the build in two other places and keeps `controllable: false`
for everything shed-related:

1. **As a sink in the surplus allocator** (`composeSurplusPool` and the
   allocator around it). Charging from surplus is the same question the water
   heater and the charger already answer: who gets the pool, in the owner's
   priority order. The battery becomes one more claimant, with
   `storageChargeCapacityKw` as its appetite.
2. **As relief before shedding** — a new stage that runs after the pace is known
   and before `buildSheddingPlan` selects anything. If the house is over the
   binding pace by `deficitKw` and the battery can deliver, PELS writes a
   discharge setpoint instead of turning the owner's devices down. Only the part
   of the deficit storage cannot cover reaches the shedding planner.

That ordering is the product: **spend stored energy before spending the owner's
comfort.** The inverse ordering is what every load-shedding controller without a
battery does, and it is what we would ship by accident if the battery were
merely another candidate in the same ranking.

Price-driven arbitrage is deliberately *not* a third entry point. Either the
battery's own trade mode owns it (leave `target_power_mode` at `device` and PELS
only observes), or the existing planning price re-ranks hours and the two entry
points above do the work. A bespoke day-planner that commits energy hours ahead
would fight the cap, which is the one thing this design exists to prevent.

## Invariants

Each of these exists because of a specific way this can go wrong.

1. **The cap holds when the battery is flat, empty, offline or autonomous.**
   Storage relief is an *optional* term. Every path that consumes it must behave
   correctly when it is zero, and the zero case must be the code's default rather
   than a branch. A design where shedding is skipped because "the battery will
   handle it" breaches the cap the first time the battery is empty.
2. **Relief is a commitment, not a measurement.** Between writing a discharge
   setpoint and the meter reflecting it, the deficit is still visible. Unless the
   commitment is held and subtracted the way `admission/reserve.ts` holds a
   restore commitment, the next build sheds a load for a deficit storage has
   already been told to cover. This is the single most likely bug in the feature
   and the first thing an e2e must pin.
3. **The battery's own draw stays real load.** A charging battery's positive
   `measure_power` is consumption and already counts toward the cap. Charging is
   therefore self-limiting through the ordinary pace, and a "charge as fast as
   the inverter allows" path that ignores the pace would breach the cap from
   inside the feature.
4. **The owner's reserve is a floor, not a suggestion.** `storageReserveSocPct`
   bounds discharge, and the lever reports zero discharge capacity at or below
   it. A capacity emergency does not license discharging the evening away; that
   is what shedding is for.
5. **Never fabricate a reading.** An absent SoC or power read is `unavailable`,
   which means no lever this cycle, and the last good value carries forward under
   the ordinary observation rules. An absent SoC is not 50 %, which is what the
   field default in a peer implementation does today.
6. **One write seam.** Every setpoint goes through `lib/actuator`, which needs a
   new intent kind (`{ kind: 'power', deviceId, watts }`, signed). The mode claim
   (`target_power_mode: 'homey'`) and any vendor strategy precondition belong to
   the transport binding, not to the planner or to `setup/`.
7. **Setpoint chatter is a defect.** The plan rebuilds on every admitted meter
   reading, up to every 10 s. A setpoint that tracks the meter one-to-one will
   cycle the inverter continuously. The lever needs the settle/dwell treatment
   stepped loads already have (`admission/surplusAbsorb.ts`), expressed as a
   minimum interval and a deadband in watts, not as a rounding accident.
8. **Cycling must beat its own cost.** A charge/discharge round trip loses
   roughly 10-15 %. A lever that cycles to save less than the loss makes the
   owner poorer while reporting a saving. `storageRoundTripLossPct` gates the
   price-motivated cases; capacity relief is exempt, because the alternative
   there is shedding the owner's devices rather than a smaller bill.
9. **Export-side safety is real.** A battery discharging on top of PV can push
   the connection over its per-phase limit in the export direction. The lever's
   discharge capacity is bounded on both sides.
10. **Mode-only batteries get an honest, degraded lever.** If PELS cannot express
    watts, it must not pretend it can: the lever reports what it can actually do,
    and the UI says so. A silent brand-guess fallback that writes `onoff` and
    hopes is how a peer implementation currently fails.

## Ownership and new seams

- **`lib/battery/` (new peer domain module).** Owns the lever: the resolved
  storage state, the capacities, the reserve policy, the settle clock, and the
  decision of what setpoint to ask for. It imports no peer domain module. It is
  injected into the planner as flat producer-resolved getters, exactly as
  `lib/solar`'s curtailment term is today (`getInferredSurplusKw`). The planner
  never learns which brand, capability or channel is behind it.
- **Observation** stays with `lib/device`: `isHomeBatteryDevice` already
  role-detects, `extractBatteryState` (`managerEnergy.ts`) already validates SoC
  and power per device into an all-or-null aggregate, and
  `batteryStateProducer.ts` holds the detected set and emits the observation. What is missing is the control
  surface classification (setpoint, mode-only, autonomous) and the `min`/`max`/
  `excludeMin`/`excludeMax` read, which belong beside the existing native
  stepped-load capability reads.
- **Write** goes through `lib/actuator` with the new signed-power intent.
- **Settings** for capacity, reserve, per-unit limits and the owner's opt-in are
  read by both the runtime and the settings UI, so their owner is
  `packages/shared-domain/src/settings/` per `notes/settings-key-ownership.md`.
  Configuration lives in `homey.settings`; nothing about the lever belongs in the
  userdata store.
- **`setup/`** constructs and connects only. The lever is a `lib/battery`
  component; the settle clock and the last-written setpoint are its state, not
  wiring state.

## Staged delivery

Each slice is shippable and observable on its own. The order is deliberate: the
write seam and the honesty come before any optimisation.

1. **Classify and observe.** Detect the control surface, read the capability
   bounds, expose `storageLeverAvailable` plus capacities, log what the battery
   does. No writes. Proves the detection on real hardware, including the
   mode-only and autonomous cases.
2. **The write seam.** The signed-power intent through the actuator, the mode
   claim, the settle clock and the deadband. Exercised by a Flow card or a
   developer setting rather than by the planner, so the write path is proven
   before a decision depends on it.
3. **Charge from surplus.** The battery joins the surplus allocator as a sink,
   under the owner's existing priority ordering. This is the smallest slice that
   is worth something to a Dutch owner after 2027, and it cannot breach the cap
   because charging is ordinary load under the pace.
4. **Discharge as cap relief.** The pre-shed stage, with the commitment
   accounting from invariant 2. The e2e that matters: over the pace, battery
   charged, and no managed device is shed; then battery empty, and the shed
   happens exactly as it does today.
5. **Reserve and honesty.** The owner's floor, the UI surface that says what the
   lever is doing and why, and the savings view (self-consumption value, export
   value, and arbitrage as discharged energy times the price difference). The
   export price model this needs already ships.

## Deliberately out of scope

A day-ahead battery schedule; per-unit orchestration beyond an aggregate for
multi-battery homes; inverter curtailment; driving export to exactly zero; and
the quarter-netting target below, which deserves its own note.

**Quarter netting is a separate idea worth its own note.** After net metering
ends, a Dutch supplier settles per 15-minute block, so "keep each block's net
near zero" is the shape that saves money, not "use less overall". PELS already
handles 15-minute price periods and already tracks a capacity quarter. The
battery makes a quarter-net target actually reachable, but the target is a
pricing concept, not a battery concept, and conflating the two would put supplier
settlement rules inside the lever.

## Open questions for the owner

1. **Lever ordering when three claimants want the same kilowatt.** Solar
   surplus, the battery and a deadline smart task can all want it. Today the
   owner's device priorities order loads. Is the battery a claimant *in* that
   ordering (so a high-priority water heater outranks it), or a floor under it
   (charge first, because stored energy is worth more later)?
2. **Do we ever take a battery out of its own optimiser?** Claiming
   `target_power_mode: 'homey'` disables the vendor's self-consumption and
   trading logic for as long as we hold it. That may be worse than leaving it
   alone for an owner whose battery trades well. Opt-in per battery, presumably,
   but the default matters.
3. **Mode-only batteries: support or refuse?** A coarse lever is still a lever
   for cap relief, but it cannot be metered accurately, and invariant 2 needs a
   number. I lean towards supporting observation and refusing control until a
   setpoint exists.
4. **Whose floor is the reserve?** Many batteries already enforce their own.
   Ours would be a second floor above theirs, which is honest but adds a setting
   the owner has to understand.

## Revisit trigger

Revisit when any of these happens: the first slice lands and real hardware
contradicts the control-surface classification; an owner ruling answers any
open question above; Homey changes the battery capability contract; or a second
domain (EV, thermostat) needs the same signed-power intent, at which point the
actuator kind is no longer battery-specific and this note's seam section is
stale.
