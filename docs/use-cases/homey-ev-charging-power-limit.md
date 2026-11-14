---
title: Homey EV charging without crossing your power limit
description: Use PELS to coordinate EV charging with whole-home power limits, cheap hours, priorities and Homey charger apps.
---

# Homey EV charging without crossing your power limit

EV charging is usually one of the largest flexible loads in a home. That makes it useful for price shifting and peak shaving, but risky if it runs at the same time as heating, hot water, cooking, or ventilation.

PELS helps Homey coordinate EV charging with the rest of the house. It watches whole-home power, protects the configured hard cap, and calculates how much available power can be used by lower-priority loads. When there is room, charging can continue. When the house approaches the power limit, PELS can reduce or pause charging before the limit is crossed.

## When this is useful

Use this setup when you want to:

- charge an EV in cheaper hours
- charge in cheap hours without letting charging ignore the rest of the home
- avoid crossing a capacity tariff or power-limit step
- use peak shaving to keep short high-load periods below the hard cap
- keep EV charging from competing blindly with heating or hot water
- let higher-priority devices win when available power is limited
- control an Easee, Alfen, Peblar, Enua, Zaptec, Futurehome, Wallbox, amina or go-e charger or a Tesla directly, or use a Homey Flow for another charger integration

PELS plays the brain role and lets your charger app keep doing what it does best: PELS decides the desired charging current or available power based on price, total power, and priorities; the charger app delivers it to the charger.

## How it works

1. Homey receives whole-home power from Homey Energy, Tibber Pulse, AMS/HAN/P1, or Flow data.
2. PELS reads the current house load and configured hard cap.
3. PELS calculates how much power is available for managed devices.
4. PELS sets the charging current or power through the charger's Homey app.

PELS controls Easee, Zaptec, Alfen, Peblar, Enua, Futurehome, Wallbox, amina, go-e and Tesla charging directly, and starts and stops Smappee EV Wall and Zappi chargers. For any other charger with a current action in its Homey app, PELS exposes the desired current as a Flow tag and a Homey Flow passes it to the charger app.

PELS handles planning, priorities, cheap hours, and power-limit protection.

<figure class="docs-figure">
  <img class="docs-diagram" src="/diagrams/ev-charging-handoff.svg" alt="Diagram showing power data flowing into PELS, PELS sending desired charging current to a Homey Flow, and the charger app applying it to the EV charger." />
  <figcaption>For a charger PELS cannot control directly, PELS calculates the desired current and a Flow passes it to the charger app. Supported chargers need no Flow.</figcaption>
</figure>

## Example: EV charging has lower priority than heating and hot water

In this setup, the EV is flexible. Hot water and critical heating should win first.

Example priority order:

1. critical heating
2. hot water
3. normal heating
4. EV charging
5. ventilation boost or other flexible loads

If total power gets close to the hard cap, PELS can reduce or pause the EV first. When the house load drops again, PELS can resume charging.

This is a good default for homes where the car only needs to be ready by morning, not charge as fast as possible all evening.

## Example: EV charging has higher priority

Sometimes the EV is the important task. For example, the car may need enough charge before an early trip.

In that case, give the EV a higher priority or use a Smart task with a target and ready-by time. PELS can then protect the hard cap while still giving the EV more room than less important loads.

This does not mean the hard cap is ignored. The hard cap still wins. Priorities decide which devices are reduced first when power is limited.

## Cheap hours still need power room

Cheap electricity is only useful if there is available power.

PELS can move flexible charging toward cheaper hours, but it should not blindly start everything at the same time just because the price is low. If heating, hot water, and EV charging all run together, the home may cross the configured power limit.

PELS therefore treats the hard cap as the safety boundary. Price shifting happens inside that boundary.

## What cheap-hour charging saves (illustrative)

Charging is the biggest single load most homes can move, so it's where shifting
pays off most. Add 40 kWh in a session during 0.40 kr/kWh night hours instead of
a 1.20 kr/kWh evening peak, and you pay about **16 kr instead of 48 kr** — roughly
30 kr a charge, with no change to how charged the car is by morning.

The figures are illustrative; the wider your day's cheap-to-expensive price
spread, the more there is to save. A [Smart task](../smart-tasks.md) or
[Flow-booked hours](../how-to-book-cheap-hours-with-flows.md) place the charging
for you, inside the hard cap. To check your own numbers, see the **Budget → Hourly plan**
view and the price level on [PELS Insights](../insights-device.md).

## What you need

You normally need:

- a Homey Pro setup
- whole-home power measurement through Homey Energy, Tibber Pulse, AMS/HAN/P1, or Flow data
- an EV charger paired in Homey
- a charger PELS controls directly, or a charger app with a Flow action that can set charging current or available power
- a price source if you want cheap-hour charging
- configured priorities in PELS

With reliable whole-home power data in Homey, PELS keeps EV charging inside your limit hour after hour — no surprise capacity steps on the next bill.

## Supported chargers and Flows

[Configure an EV charger](../ev-charger.md#charging-current-setup) lists the chargers PELS controls through their Homey app, with no Flow. Keep the charger app you already use.

For any other charger whose Homey app exposes a current or available-power action:

- PELS calculates the desired charging current.
- A Flow passes that value to the charger app.
- The charger app applies it to the charger.

## Easee example

With the Easee app for Homey, PELS sets the charging current itself and reads it back from the charger, so there is no Flow to build for it. PELS takes the charging levels from the Easee app and turns on built-in control, unless one of your Flows already sets the charger's current.

[Configure an Easee EV charger](../easee-ev-charger.md)

## Zaptec example

With the Zaptec app for Homey, PELS sets the charging power or current itself, with no Flow.

Start here:

[Configure a Zaptec EV charger](../zaptec-ev-charger.md)

General EV charger setup:

[Configure an EV charger](../ev-charger.md)

## Related setup guides

- [Getting Started](../getting-started.md)
- [Using Homey Energy](../homey-energy.md)
- [Configure an EV charger](../ev-charger.md)
- [Configure an Easee EV charger](../easee-ev-charger.md)
- [Configure a Zaptec EV charger](../zaptec-ev-charger.md)
- [Compare cost-saving functions](../cost-saving-functions.md)
- [Smart Tasks](../smart-tasks.md)
- [Flow Cards](../flow-cards.md)
