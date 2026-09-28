# Competitive landscape: energy management on Homey

Internal market analysis. **This file names competitor apps; nothing outside
`notes/` does** (no code, comment, commit message, PR body, changelog or store
copy). Refresh trigger at the end.

Sibling notes: `notes/personas.md` (who each surface serves),
`notes/persona-acquisition.md` (where those people are found),
`notes/battery-lever.md` (the design for the gap this note says decides the
Dutch market).

## What each market actually pays for

| Market | The bill line that hurts | What software can do about it |
|---|---|---|
| Norway | `effekttariff`: monthly grade from the average of the three highest daily hourly peaks | hold the hourly peak down; shift to cheap hours |
| Flanders | `capaciteitstarief`: monthly peak of quarter-hour averages, floor 2.5 kW | hold the quarter peak down; the quarter is the unit, not the hour |
| Netherlands | from 2027 no net metering: every exported kWh earns a separate feed-in payment (at least 50 % of the bare price until 2030) while imports cost the full retail price, and suppliers may charge feed-in costs. Settlement is per 15-minute block | use your own production instead of exporting it; keep each block's net near zero; move flexible load into cheap blocks |
| Netherlands, later | time-dependent grid tariffs, targeted 2029, possibly 2030 | the Flemish problem arrives here too |

Two consequences for positioning. First, the Dutch 2027 change is a
*self-consumption* problem, not a peak problem, so a Dutch buyer's checklist is
led by battery and solar, not by a capacity guard. Second, the capacity guard
becomes the Dutch differentiator only in 2029/2030, which is exactly the horizon
where our existing strength lands.

## The field

### Ultimate EMS (`com.ultimate.ems`, v2.4.9)

Earlier name `com.ems.homey` v1.6.7 ("HEMS"), same tagline and same
`ems-controller` driver id, so treat them as one product line. Licence is
Business Source License 1.1 (MSDB Holding BV): **read for mechanism, never
copy**. Source is readable because the owner installed it on SHS
(`docker cp`, see `reference_shs_deployed_app_source` in agent memory); a copy
sits in `tmp/com.ultimate.ems`. About 23k lines.

Grounded facts from its source, not its store page:

- **Role adapters** behind interfaces (`ControllableBattery`,
  `AutonomousBattery`, `Charger`, `Thermostat`, `PowerSource`), with a long tail
  of vendor adapters: Victron GX, Huawei FusionSolar, Zendure, Marstek, Sessy,
  HomeWizard, Peblar, Alfen, Zappi, Tesla, plus generic ones.
- **Battery control is brand-guessing with an `onoff` fallback.** The generic
  adapter tries `marstek_charge_enabled` / `marstek_charge_power`, then `onoff`,
  then logs that it cannot drive the device. Only the Sessy adapter writes the
  standard signed `target_power`, and it forces a vendor strategy setting first.
- **No battery floor.** The minimum-SoC branch was removed in July 2026; low SoC
  is informational.
- **Fuse protection is arithmetic from a setting, per lever.** `_batHeadroomW`
  computes `max_amps × 230 × phases`, subtracts house and EV load inferred from
  the grid reading, and gives the battery the remainder; EV outranks the battery.
  A separate per-phase check guards the export direction.
- **One-minute control loop** (`LOOP_INTERVAL_MS`).
- **It steers only what it adapts** (battery, EV, thermostat, dump load). There
  is no general "limit any managed device because the house is near its ceiling".
- **Quarter tracking is settlement netting, not peak.** `QuarterEnergyTracker`
  tracks net Wh against the supplier's 15-minute block from cumulative P1
  registers, aiming for zero per block. That is the right Dutch model and it is a
  different thing from a capacity peak.
- Day-plan engine (~1.8k lines), day-ahead prices, PV curve, trip planner,
  cost-basis tracking, dashboards and widgets.

### SlimLaden Thuis & Auto (`com.energyprices.app`, v9.9.38)

Readable since the owner installed it on SHS; a copy sits in
`tmp/com.energyprices.app`. **About 132k lines**, of which ~51k are battery
control managers alone. This is the serious Dutch competitor, and it is a bigger
piece of software than ours.

Grounded facts from its source:

- **It owns its hardware integration, bypassing Homey's device layer.** Battery
  control goes over Modbus TCP (Victron, Solis, Marstek, AlphaESS, Anker),
  vendor clouds (Deye, Marstek, Indevolt), MQTT, or the HomeWizard API, through
  22 adapters behind one `BaseBatteryAdapter` with a normalised convention
  (positive charges, negative discharges). It even reads the P1 meter directly
  (`homewizard-p1-direct.js`, `envoy-direct.js`) to get off `homey-api`.
  Consequence: its brand support does not depend on a vendor's Homey app
  exposing a control capability, which is why its brand list is long. Cost:
  every brand is its own protocol implementation to maintain.
- **A real optimiser.** An LP (simplex) battery plan per quarter whose objective
  carries grid-charge cost, battery wear, an anti-churn epsilon, and
  solar-capture opportunity cost against the sell price. Plus a round-trip
  efficiency optimiser that learns from measured sessions
  (`rte_charge_efficiency`, `rte_discharge_efficiency`, `rte_last_session`).
- **Quarter peak shaving exists** (`PeakShavingManager`): it averages P1 over the
  running quarter and discharges the battery to hold the block average under a
  threshold, with a 60 s minimum between power changes. The battery is the only
  lever it uses for this.
- **Software NOM at a 10 s cadence** (`software-nom-module.js`): balances net P1
  to zero (or to a critical appliance's draw) with a damping factor of 0.5 to
  avoid oscillation on P1 lag. This is the Dutch per-block net target, built.
- **Appliances are observed, not controlled.** A "critical appliance" above a
  threshold pauses or redirects the battery plan; per-phase power summing exists
  because a three-phase charger's app reports only per-phase values. There is no
  lane that limits an appliance.
- **EV charging is planned and controlled** (`ev-charge-planner.js`,
  `ev-vrije-zon.js`, EV switch recovery).
- **It closes the loop on money.** `expected_profit_tomorrow`,
  `meter_profit_daily`, usage diagnostics, and a backlog view, published on its
  own devices.
- **It is monetised** (a paywall flow in `docs/`, a payment API client) and it
  has a VPP one-pager in `docs/`, so aggregation is its stated direction.

What it is not: a whole-house constraint controller. Its levers are the battery
and the car. Everything else in the house is an input to the battery plan.

### Power Guard (`no.powerguard`) and Piggy Bank (`no.sparegris`)

Norwegian capacity-tariff peers, both vendored in `tmp/`. Power Guard: HAN-meter
guard, smoothed readings, priority-ordered shedding, charger drivers, tariff
history. Piggy Bank: tariff-bounded consumption shifting with its own charger
driver and insights device. Neither controls storage; neither addresses the
Dutch 2027 problem. These are the apps we already compete with head-on in
Norway.

### Power by the Hour, and Homey Energy itself

Monitoring and cost insight, no control. Homey Energy monitors batteries and
hands the owner Flow cards; it decides nothing. Both are complements, not
competitors, and both are also the baseline a buyer compares "why do I need an
app for this" against.

## What a buyer compares

Ordered by how much it moves a purchase in the Dutch market today:

1. **Does it drive my battery, and my brand?**
2. **Does it show what it earned me, and was yesterday's promise true?**
3. **Does it plan the day, per quarter, from prices and a PV forecast?**
4. **Does it handle the car, and my comfort, without me writing Flows?**
5. **Will it keep my house inside its limits** (the Flemish question today, the
   Dutch question from 2029).
6. **Breadth of supported hardware**, because an unsupported inverter is a hard no.

## Honest scorecard

| Axis | PELS today | Ultimate EMS | SlimLaden |
|---|---|---|---|
| Whole-house ceiling from a measured meter, sub-minute | **yes**, 10 s, quarter and hourly models, Flemish quarter peak, every managed load | partial: static fuse arithmetic, 1 min, only its own levers | partial: quarter peak shaving and 10 s NOM balancing, battery as the only lever |
| Limits any managed load, by owner priority | **yes** | no | no: appliances are inputs to the battery plan |
| Battery control | **no** | yes, brand-guessy over Homey devices | yes, 22 adapters over Modbus/MQTT/cloud |
| Day-ahead money plan per quarter | partial: deadline tasks and cheapest-hour placement | yes | **yes, an LP with wear, churn and opportunity cost** |
| Savings shown and verified next day | partial: solar money for today | cost-basis tracking | **yes, expected profit and next-day check** |
| PV forecast | yes (learned plus Homey Energy) | yes | yes |
| Deadlines and comfort without Flows | **yes**, smart tasks, thermostats, water heaters | partial | EV only |
| Multi-home / meter areas | **yes** | no | no |
| Honesty when it cannot act | **yes**, plan reasons per device | partial, tick log | unknown |
| Hardware breadth | narrow on inverters and batteries | broad, via Homey devices | broad, via its own protocol stack |
| Learns the home | objective rates, weather signature | consumption learner | consumption plus measured round-trip efficiency |
| Monetised | no | no | yes, paywall, and VPP aggregation is its stated direction |

We are the only one in the table that holds the ceiling across *every* managed
load. They hold storage, and the Dutch one also holds an LP money plan, verified
savings and far wider hardware. Neither side is a superset, but note the asymmetry
in effort: their missing piece (limit a water heater by priority) is a feature;
ours (22 protocol adapters, an LP solver, learned round-trip efficiency) is a
program.

## The wedge, stated as a promise

**Your ceiling holds even when the battery is flat.** This is sharper now that we
know the Dutch competitor already shaves the quarter peak and already balances the
block to zero every 10 s: it does both *with the battery as its only lever*. When
the battery is empty or busy, its peak shaving has nothing left, and its own
documentation treats a big appliance as something to work around rather than
something to turn down. A load shedder cannot say the interesting half either,
because it never avoids the shed in the first place. One controller holding cap,
budget, loads and storage can say both: *spend stored energy before spending your
comfort, and when storage runs out, spend the least valuable comfort first.*

The Dutch 2027 version of the same sentence: *use your own production first, keep
each 15-minute block near zero, and never let either goal push the house over its
limit.*

## What would make us lose

- **Not shipping the battery lever.** A Dutch battery household does not shortlist
  an app that cannot drive the battery, whatever else it does well.
- **Shipping it as a second optimiser.** If the battery gets its own scheduler
  that the cap then has to fight, we inherit their weakness and lose ours.
- **No verified savings.** Both competitors show money, and the Dutch one shows
  expected profit for tomorrow and then lets the owner check it. A controller that
  asks for trust and shows nothing loses to one that shows a number, even a
  rougher one.
- **Claiming novelty they already shipped.** Per-block net balancing and quarter
  peak shaving exist in their product. Our version is only interesting because it
  can also move loads; saying it as though nobody had done it invites a direct
  comparison we would lose on the battery half.
- **Underestimating the hardware strategy.** They integrate batteries over Modbus,
  MQTT and vendor clouds rather than through Homey device apps, so their brand
  list grows independently of what vendors expose. We will not out-adapter them;
  our answer has to be the standard capability contract plus the levers they do
  not have.
- **Inverter and battery breadth.** Mitigated by building on the standard
  `target_power` / `target_power_mode` contract rather than per-brand
  capabilities, which covers every compliant battery at once. Per-brand work
  only where a popular brand has no standard surface.
- **Invisibility.** The Dutch store copy now leads with the end of netting; that
  has to stay true as the feature set changes.

## Plan, cheapest high-impact first

1. **Savings and verification surface.** No battery needed: the export-price
   model, solar money and the daily budget are already there. Show what
   self-consumption was worth, what export earned or cost, and whether the day
   matched the plan. This is the axis where we are weakest for the least work.
2. **Battery lever, slices 1 to 4** of `notes/battery-lever.md`: classify and
   observe, the signed write seam, charge from surplus, discharge before
   shedding. Slice 4 is the wedge made real.
3. **Quarter-net target for the Netherlands, with loads in it.** Our capacity
   quarter and 15-minute prices exist; the missing piece is a per-block net target
   the levers aim at. The competition already does this with the battery, so the
   only version worth shipping is the one that also defers a water heater or trims
   a charger to hold the block, and that says honestly which lever it used.
4. **Standard-capability breadth.** Batteries through `target_power`, and a check
   of which popular Dutch inverters and batteries expose it, so the brand list
   stops being a per-vendor grind.
5. **Do not build:** a day-ahead trading optimiser (delegate to the battery's own
   trade mode), an EV trip planner (defer), inverter curtailment (their Victron
   and Huawei adapters do it; it is not our wedge).

## Refresh trigger

Revisit when: the battery lever lands (the scorecard's decisive row changes);
either competitor ships a lane that limits an ordinary managed load by priority,
which attacks our wedge directly; the Dutch one's VPP direction turns into
aggregation an owner can join, which changes what a battery is worth; ACM fixes
the date for Dutch time-dependent grid tariffs; or a new entrant appears in the
Homey store's energy category. Both competitors' sources are vendored under
`tmp/` and were read at the versions named above; re-read before trusting a row.
