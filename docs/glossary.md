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
> day. The hard cap watches your speed; the daily budget watches your distance.

### Hard cap {#hard-cap}
The maximum **average power** (in kW) you want the whole home to draw in any one
hour. PELS treats this as the boundary it protects above all else. Set it to
match your grid tariff step or breaker limit. It is a **physical** property of
your connection — not a setting you raise to get more room. See
[Getting Started → Set your capacity limit](/getting-started#step-2-set-your-capacity-limit).

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
The power level where PELS starts acting right now. It's the hard cap minus the
safety margin — and, when a daily budget is active and tighter, it can drop below
that to keep the day on plan. On the Overview it shows as the **Safe pace now**
marker. It's a moving target, not a fixed limit.

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

### Device states (Limited, Resuming, Idle, Manual)
The chips on the Overview that say what PELS is doing to each device right now.
**Limited** = PELS is lowering, pausing, or turning it off to stay under the hard
cap or daily budget pace; **Resuming** = bringing
it back as power frees up; **Idle** = off and not held back; **Manual** = managed
but PELS has no power-limit control of it right now. Full list:
[Plan States](/plan-states).

### Power-limit control
The per-device switch that lets PELS lower or turn the device off to protect the
hard cap. With it off, the device stays under PELS's planning but is never limited
for capacity — useful for an EV charger you only want running during booked hours.

## Prices

### Spot price / price source
The hourly electricity price PELS plans around. The **Norway** source combines
spot price, grid tariff, surcharges and your chosen support scheme into one hourly
price; **Homey Energy** and **Flow tag** sources work anywhere with hourly prices.
See [Using Homey Energy](/homey-energy).

### Cheap-hour boost / expensive-hour reduction
Temperature nudges (in °C) PELS applies to a price-aware device when electricity
is cheap or expensive — for example +2 °C overnight, −2 °C during the evening peak.

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
