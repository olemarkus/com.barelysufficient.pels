---
title: "How PELS Decides: The Measure, Plan, Act Loop in Plain English"
description: A plain-language mental model of how PELS works — the loop it runs every time your power changes, what it protects first, how it chooses what to turn down, and how it brings devices back.
---

# How PELS Decides

You don't need to know the internals to trust PELS, but a simple mental model
helps. This page is the big picture in plain language. For the exact rules and
numbers, see the [Technical Reference](/technical); for definitions of any word
here, see the [Glossary](/glossary).

## One loop, over and over

Every time your whole-home power reading changes, PELS runs the same short loop:

<figure class="docs-figure">
  <img class="docs-diagram" src="/diagrams/pels-control-loop.svg" alt="Diagram showing whole-home power data flowing into PELS, PELS applying hard cap, priorities, prices, modes and Smart tasks, and then managing EV charging, hot water, heating and ventilation." />
  <figcaption>PELS sits between your power meter and your big loads, deciding what should run, pause, or resume every hour.</figcaption>
</figure>

1. **Measure.** Read how much power the home is drawing right now (from
   [Homey Energy](/homey-energy) or a Flow).
2. **Plan.** Compare that against your [hard cap](/glossary#hard-cap), today's
   [daily budget](/glossary#daily-budget), prices, the active [mode](/glossary#mode),
   and any [Smart tasks](/glossary#smart-task).
3. **Act.** Lower, pause, or resume the [managed devices](/glossary#managed-vs-background-usage)
   it controls — gently, with short cool-downs so nothing flaps on and off.

The next reading starts the loop again, so PELS keeps adapting to what actually
happened.

## What PELS protects, in order

The features stack. Each one works *inside* the one above it, so they never fight:

1. **The hard cap comes first.** PELS will always act to keep the home's hourly
   average under your [hard cap](/glossary#hard-cap). This is the only thing that
   triggers an urgent alert, because crossing it costs you — a higher capacity
   tariff step or a tripped breaker.
2. **The daily budget paces the day.** If you've set one, PELS spreads your kWh
   target across the day and slows the home down when it's running ahead — but
   only ever makes PELS *more* cautious, never less. It's a soft target, not an
   alarm.
3. **Prices steer flexible load.** With a price source, PELS nudges water heaters,
   floor heating, and charging toward the cheapest hours, and trims comfort
   slightly in the priciest ones — all still under the cap.
4. **Smart tasks reserve attention for deadlines.** When one device must be ready
   by a time, a [Smart task](/smart-tasks) gives it the hours it needs — still
   inside everything above.

## How PELS chooses what to turn down

PELS doesn't react at the hard cap itself — it reacts a little earlier, at the
[safe pace](/glossary#safe-pace) (the cap minus your [safety margin](/glossary#safety-margin),
or lower when the daily budget is the tighter constraint). When the home crosses
the safe pace, PELS eases devices off **in [priority](/glossary#priority) order**:
the least important device (highest priority number) goes first, the most
important stays running longest. Priorities are per [mode](/glossary#mode), so
your bedroom can outrank the water heater at night and not during the day.

## How PELS brings devices back

As power frees up, PELS resumes devices in the **opposite** order — most important
first. It waits a short cool-down between steps (60 seconds after limiting, 60–300
seconds before resuming) so devices don't rapidly flip on and off. If the day is
running ahead of its daily budget, resumes wait a little longer.

## What you set vs what PELS does

| You decide (once) | PELS handles (every hour) |
| --- | --- |
| The hard cap and safety margin | Watching live power and projecting the hour |
| Which devices are managed, and which it may limit | Easing devices off before the cap |
| Priorities and target temperatures per mode | Choosing what to turn down, and what to keep |
| An optional daily budget and price source | Shifting flexible load into cheaper hours |
| Smart tasks for things that must be ready | Bringing devices back as power returns |

Set it up once, switch modes from Flows, and let the loop run. When something
looks off, the [Troubleshooting guide](/troubleshooting) maps symptoms to fixes.

## Where to go next

- [Getting Started](/getting-started) — install and first setup
- [Compare Cost-Saving Functions](/cost-saving-functions) — which feature solves your problem
- [Glossary](/glossary) — any term, defined
- [Technical Reference](/technical) — the exact rules and numbers
