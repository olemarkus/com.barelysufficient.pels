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
- use Homey Flows to connect PELS to a charger app such as Zaptec, Easee, or another charger integration

PELS is not a replacement for the charger app. The charger app still talks to the charger. PELS decides the desired charging current or available power based on price, total power, and priorities.

## How it works

A typical Homey EV charging setup looks like this:

1. Homey receives whole-home power from Homey Energy, Tibber Pulse, AMS/HAN/P1, or Flow data.
2. PELS reads the current house load and configured hard cap.
3. PELS calculates how much power is available for managed devices.
4. PELS exposes the desired EV charging current through Flow tags.
5. A Homey Flow sends that value to the charger app.

The important split is:

- PELS handles planning, priorities, cheap hours, and power-limit protection.
- The charger app handles the actual charger command.

<figure class="docs-figure">
  <img class="docs-diagram" src="/diagrams/ev-charging-handoff.svg" alt="Diagram showing power data flowing into PELS, PELS sending desired charging current to a Homey Flow, and the charger app applying it to the EV charger." />
  <figcaption>PELS calculates the desired charging current. The charger app still sends the actual command to the charger.</figcaption>
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

## What you need

You normally need:

- a Homey Pro setup
- whole-home power measurement through Homey Energy, Tibber Pulse, AMS/HAN/P1, or Flow data
- an EV charger paired in Homey
- a charger app or Flow action that can set charging current or available power
- a price source if you want cheap-hour charging
- configured priorities in PELS

PELS works best when Homey has reliable whole-home power data. Without that, PELS cannot know whether charging will push the home above the limit.

## Charger apps and Flows

PELS does not need to support every charger API directly. The normal pattern is to use the charger app that already works with your charger, then connect PELS to it with Homey Flows.

For example:

- PELS calculates the desired charging current.
- A Flow reads the PELS current value.
- The Flow sends that value to the charger app.
- The charger app applies it to the charger.

This keeps PELS focused on whole-home power management instead of duplicating every charger integration.

## Zaptec example

Zaptec chargers are a good example because the Zaptec Homey app can expose actions for available charging current. PELS can calculate the desired current, and a Flow can pass that value to Zaptec.

Start here:

[Configure a Zaptec EV charger](../zaptec-ev-charger.md)

General EV charger setup:

[Configure an EV charger](../ev-charger.md)

## Related setup guides

- [Getting Started](../getting-started.md)
- [Using Homey Energy](../homey-energy.md)
- [Configure an EV charger](../ev-charger.md)
- [Configure a Zaptec EV charger](../zaptec-ev-charger.md)
- [Compare cost-saving functions](../cost-saving-functions.md)
- [Smart Tasks](../smart-tasks.md)
- [Flow Cards](../flow-cards.md)
