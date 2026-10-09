---
title: "PELS Glossary: kW vs kWh, Hard Cap, Safe Pace, Capacity Tariff & More"
description: Plain-language definitions of the words PELS uses — power vs energy, hard cap, safe pace, safety margin, capacity tariff, daily budget, managed vs background, priority, modes, Smart tasks, and state of charge.
---

# Glossary

Plain definitions of the words PELS uses. New to the app? Read
[How PELS Decides](/how-pels-decides) for the big picture, then use this page
to look up any term. Each entry links to where it matters most.

## Power and capacity

### Power (W / kW)
How much electricity your home is drawing **right now** — an instantaneous rate.
1 kW = 1000 W. A kettle pulls ~2 kW while it's on. Think of it as *speed*.

### Energy (kWh)
Power used **over time** — the meter total. Running 2 kW for one hour uses 2 kWh.
Think of it as *distance travelled*. Your daily budget is in kWh; your hard cap
is about kW.

> **Power vs energy, in one line:** power (kW) is how fast you're using
> electricity right now; energy (kWh) is how much you've used over an hour or a
> day. The hard cap watches the selected capacity period's distance; the daily
> budget watches the whole day's.

### Hard cap {#hard-cap}
The maximum **average power** (in kW) you want the whole home to draw in one
capacity period. PELS supports an hourly period and a 15-minute period,
and treats the selected one as the period boundary it protects. Set it
to match the peak or tariff step you want to protect. It is not a setting you
raise to get more room. If you have no capacity tariff at all, turn off **Capacity limit**.
Your main fuse is a separate physical limit that PELS does not manage. A
[grid import limit](#grid-import-limit) can keep import below a level you choose, but it is
not electrical protection. See
[Getting Started → Set your limits](/getting-started#step-2-set-your-limits).

### Grid import limit {#grid-import-limit}
The most power, in kW, you want the home to draw from the grid at any moment, for example
the contracted power of your meter. Unlike the hard cap, it is not an average: PELS compares
the latest whole-home net import reading with it and starts reducing loads near 95% of it.
Solar export counts as available power. A short overshoot is possible while the meter updates
and devices respond, so it is not a circuit breaker.

### Capacity tariff (effekttrinn)
A grid pricing model — common in Norway, Sweden and Finland — where your monthly
grid fee depends on your **highest power use**, sorted into steps. In Norway the
charge is the *kapasitetsledd* and the steps are *effekttrinn*; staying under a
step keeps you in a cheaper band. PELS's hard cap is how you hold a step.

### Safety margin
A buffer (in kW) below the hard cap. PELS starts easing devices down *before* the
home actually reaches the cap, so it has time to react. A margin of 0.3–0.5 kW is
a sensible start. See [Tips → Capacity tuning](/tips-and-best-practices#capacity-tuning-advice).

### Safe pace
The power level where PELS starts acting right now. On the 15-minute period it
never rises above the hard cap minus the safety margin. On the hourly period it
paces the allowance left in the hour, so in an under-used hour it legitimately
sits *above* that level and tightens toward it as the hour ends. When a daily
budget is active and tighter, it can drop below either. On the Overview it shows
as the **Safe pace now** marker. It's a moving target, not a fixed limit.

### Available power
How much more load PELS can fit right now before it reaches the current safe
pace, in kW. When it's positive, paused devices can resume; when it's near zero,
PELS holds or eases devices off.

## Budget and pacing

### Daily budget
An optional **soft** target for total energy in a day (in kWh). PELS paces the
home toward it — leaning on cheap hours when price optimization is on — but it
never overrides the hard cap and never raises an urgent alarm. Off by default.
See [Daily Energy Budget](/daily-budget).

### Daily pace
How fast PELS thinks the home should be using power right now to land on the
daily budget. Ahead of plan → the pace eases; behind plan → it rises. PELS always
uses the **tighter** of the daily pace and the hard-cap pace.

### Managed vs background usage
**Managed** devices are the ones PELS plans and controls (the loads you marked
*Managed*). **Background usage** is everything else — lights, appliances, the
fridge — that PELS measures but cannot move. Charts split usage this way.

## Devices and control

### Priority
A number per device, per mode, where **lower means more important**. When PELS
must turn things down it starts with the highest numbers (least important) and
works up; when room returns it resumes in the opposite order.

### Mode
A saved profile — such as **Home**, **Away**, or **Night** — holding its own set
of priorities and target temperatures. Switch modes from Homey Flows. See
[Configuration → Modes](/configuration#settings-modes).

### Device states (Limited, Resuming, Idle, Off, Manual)
The state words on the Overview that say what each device is doing right now.
**Limited** = PELS is lowering, pausing, or turning it off to stay under the grid
import limit, the hard cap or daily budget pace, or keeping it waiting for power; **Resuming** = PELS has
decided to bring it back and is turning it on or raising its level; **Idle** = on
or available with nothing to do;
**Off** = Homey reports the device off and PELS is not limiting it;
**Manual** = managed
but PELS has no power-limit control of it right now. Full list:
[Plan States](/plan-states).

### Power-limit control
The per-device switch (**Limit** in the device list) that lets PELS lower, pause or
turn off the device: to stay under your grid import limit or hard cap, to keep to your
daily budget, or to follow your solar surplus. With it off, PELS still plans around
the device but never limits it, which suits an EV charger you only want running
during booked hours.

## Prices

### Spot price / price source
The electricity price for the period it covers — an hour on most sources, or
15 minutes where your Homey Energy zone publishes quarter-hour prices. The
**Norway** source combines spot price, grid tariff, surcharges and your chosen
support scheme into one hourly price; the **Homey Energy**, **Power by the Hour**
and **Flow** sources work anywhere those prices are published, and hand over the
price as their source states it.
For most homes this is the price PELS plans around; homes with an export price plan
against the derived **planning price** (below). See [Using Homey Energy](/homey-energy).

### Import price
The price you are billed per kWh — every cost figure and receipt stays on this. On
homes without solar it is simply "the price"; the **Import price** label only appears
on surfaces that also show an export or planning price.

### Export price
What you are paid — or charged — per kWh for power you export to the grid. Turn it on
under **Settings > Electricity prices** when you have solar; the Budget tab shows
**Export price now** for the current hour. See [Solar and Self-Consumption](/solar).

### Planning price
The derived price PELS plans against when you have an export price: a blend of import
and export that reflects what your energy is actually worth to you. It is always an
estimate — your bills and receipts stay on the import price. Surfaces that act on it
show a *using your solar* reason line.

### Cheap-hour boost / expensive-hour reduction
Temperature nudges (in °C) PELS applies to a price-aware device while electricity
is cheap or expensive: for example 2 °C up overnight and 2 °C down during the
evening peak. A unit that is cooling moves the other way.
They follow the price for as long as it lasts, which is a quarter of an hour where
your source publishes 15-minute prices.

## Solar

### Solar surplus
Solar power available beyond what your home is using right now: either exported to
the grid or inferred when a zero-export inverter throttles production to match the
house. PELS can steer flexible devices to soak it up instead of exporting it cheaply.
Devices and home batteries share it in [priority](#priority) order: with the battery
last, the default, your devices get the sun first, then the battery, then the grid.
See [Solar and Self-Consumption](/solar).

### Home battery
A battery paired with Homey whose app lets PELS set how much it charges or
discharges. It is a managed device with its own Overview card (**Supplying**,
**Charging**, **Limited · Charging** or **Own mode**) and a place in your priority list, last by default.
PELS uses it to share your solar surplus and, on its turn, to hold your limit:
first by capping its charge, then by discharging. **Managed by PELS** turns this
on or off, and **Power-limit control** decides whether it may hold your limit. See
[Solar and a home battery](/use-cases/homey-solar-home-battery).

### Use solar surplus / Run on solar surplus
Per-device settings for prosumers. **Use solar surplus** lifts a device's target
(for example a warmer water heater) while there is surplus; **Run on solar surplus**
runs an on/off device (pool pump, towel dryer) only while surplus covers it.

## Smart tasks

### Smart task
A one-off goal for **one** device: reach a target by a ready-by time (e.g. charge
to 80 % by 07:00, or 21 °C by 06:30). PELS picks the best hours before the
deadline. See [Smart Tasks](/smart-tasks).

### State of charge (SoC)
An EV battery's charge level, as a percentage. A charging Smart task aims for a
target SoC (e.g. 80 %) by its ready-by time. See
[Deadline Charging With State of Charge](/how-to-deadline-charging-soc).

### Ready-by time
The deadline a Smart task plans toward — written as a local clock time, e.g.
`07:00`. PELS lines up usable hours before it.
