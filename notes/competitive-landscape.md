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

### SlimLaden voor Thuisbatterij / SmartLoading (`com.energyprices.app`)

**Store-page and community-thread level only; not installed on SHS, so no code
read yet.** Claims: a per-quarter charge plan for the battery from consumption,
PV forecast and dynamic prices; learns the home's consumption pattern and the
battery's round-trip efficiency; makes the profit visible and lets the owner
check the next day whether the forecast came true; pauses the battery for
critical appliances; smart EV charging. Brand list: Marstek, Venus, Sessy,
HomeWizard, IndeVolt, AlphaESS, Zendure, Victron, Deye (beta), Anker SOLIX.

This is the sharpest Dutch competitor for a battery household: it is *only* the
battery-and-price problem, and it closes the loop by verifying yesterday's
promise.

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
| Whole-house ceiling from a measured meter, sub-minute | **yes**, 10 s, quarter and hourly models, Flemish quarter peak | partial: static fuse arithmetic, 1 min, only its own levers | no |
| Limits any managed load, by owner priority | **yes** | no | no (pauses the battery for "critical appliances") |
| Battery control | **no** | yes, brand-guessy | yes, its core |
| Day-ahead money plan per quarter | partial: deadline tasks and cheapest-hour placement | yes | yes |
| Savings shown and verified next day | partial: solar money for today | cost-basis tracking | yes, its selling point |
| PV forecast | yes (learned plus Homey Energy) | yes | yes |
| Deadlines and comfort without Flows | **yes**, smart tasks, thermostats, water heaters | partial | EV only |
| Multi-home / meter areas | **yes** | no | no |
| Honesty when it cannot act | **yes**, plan reasons per device | partial, tick log | unknown |
| Hardware breadth | narrow on inverters and batteries | broad | broad, batteries |

We are the only one in the table that holds the ceiling across *every* managed
load. They are the only ones that hold storage. Neither side is a superset.

## The wedge, stated as a promise

**Your ceiling holds even when the battery is flat.** A battery optimiser cannot
say this, because when storage is empty it has no other lever. A load shedder
cannot say the interesting half either, because it never avoids the shed in the
first place. One controller holding cap, budget, loads and storage can say both:
*spend stored energy before spending your comfort, and when storage runs out,
spend the least valuable comfort first.*

The Dutch 2027 version of the same sentence: *use your own production first, keep
each 15-minute block near zero, and never let either goal push the house over its
limit.*

## What would make us lose

- **Not shipping the battery lever.** A Dutch battery household does not shortlist
  an app that cannot drive the battery, whatever else it does well.
- **Shipping it as a second optimiser.** If the battery gets its own scheduler
  that the cap then has to fight, we inherit their weakness and lose ours.
- **No verified savings.** Both competitors show money. A controller that asks for
  trust and shows nothing loses to one that shows a number, even a rougher one.
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
3. **Quarter-net target for the Netherlands.** Our capacity quarter and 15-minute
   prices exist; the missing piece is a per-block net target the levers aim at.
   This is the one thing that beats a battery optimiser *at its own objective*,
   because we can move loads too.
4. **Standard-capability breadth.** Batteries through `target_power`, and a check
   of which popular Dutch inverters and batteries expose it, so the brand list
   stops being a per-vendor grind.
5. **Do not build:** a day-ahead trading optimiser (delegate to the battery's own
   trade mode), an EV trip planner (defer), inverter curtailment (their Victron
   and Huawei adapters do it; it is not our wedge).

## Refresh trigger

Revisit when: the battery lever lands (the scorecard's decisive row changes);
SlimLaden is installed on SHS and its code can be read, which would replace the
store-page row with grounded facts; Ultimate EMS ships a general load-limiting
lane, which would attack our wedge directly; ACM fixes the date for Dutch
time-dependent grid tariffs; or a new entrant appears in the Homey store's energy
category.
