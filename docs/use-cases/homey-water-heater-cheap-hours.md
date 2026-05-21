---
title: Run hot water and heating in cheaper hours with Homey
description: Use PELS to move water heaters, floor heating, panel heaters and ventilation toward cheap electricity hours while protecting your power limit.
---

# Run hot water and heating in cheaper hours with Homey

Water heaters, floor heating, panel heaters and ventilation can use a lot of power. They are also often flexible: they do not always need to run at the exact moment the price is high.

PELS helps Homey move flexible load toward cheaper hours while still protecting the configured power limit. That matters because the cheapest hour is not always the best hour if EV charging, cooking, heating, and hot water all run at the same time.

## When this is useful

Use this setup when you want to:

- heat water in cheaper hours
- preheat rooms before you come home
- lower heating when prices are high
- avoid running several large loads at the same time
- keep the home below a capacity tariff step or power limit
- let higher-priority devices win when available power is limited

PELS is useful when the load can move in time. A water heater, floor heating loop or panel heater usually has some thermal buffer. A device that must run immediately is less suitable for price shifting.

## Price shifting still needs a hard cap

A common mistake is to turn on every flexible device when the price is low.

That can backfire. If hot water, floor heating, ventilation boost and EV charging all start in the same cheap hour, the home may cross the configured power limit or move into a more expensive capacity tariff step.

PELS treats the hard cap as the boundary. Price shifting happens inside that boundary.

## Typical priority setup

A simple default priority order could be:

1. critical heating
2. hot water
3. normal room heating
4. EV charging
5. ventilation boost or other flexible comfort loads

This is only a starting point. The right order depends on the home. If the car must be ready early, EV charging may need higher priority. If hot water is critical in the morning, the water heater may need a Smart task with a ready-by time.

## Water heater example

A water heater is a good candidate for cheap-hour shifting because it stores heat.

PELS can prefer cheaper hours when there is enough room under the hard cap. If the house load gets too high, PELS can lower, pause or turn off lower-priority devices first. When power becomes available again, PELS resumes devices in priority order.

For one-off needs, use a Smart task. For example:

- hot water should be ready before morning
- the tank should recover after heavy use
- heating should finish before a known deadline

Start here:

[Smart Tasks](../smart-tasks.md)

## Heating example

Heating is often flexible, but only within comfort limits.

PELS can use Home, Away and Night modes to apply different comfort targets and priorities. For example, heating can be more relaxed while away, stricter when home, and biased toward cheap hours overnight.

Start here:

[Open configuration docs](../configuration.md)

## Ventilation example

Ventilation is usually not the first load to control, but boost modes or higher fan levels can be flexible in some homes.

If ventilation is exposed to Homey in a controllable way, PELS can treat it like another prioritized load. Keep safety and indoor-air requirements in mind. Do not reduce ventilation in a way that creates moisture or air-quality problems.

## What you need

You normally need:

- Homey Pro
- whole-home power measurement through Homey Energy, Tibber Pulse, AMS/HAN/P1 or Flow data
- a price source if you want cheap-hour shifting with dynamic prices or spot price
- one or more controllable devices in Homey
- configured priorities in PELS
- sensible comfort limits for heating and hot water

PELS works best when the home has both reliable whole-home power data and devices that can actually be controlled from Homey.

## Which PELS feature should you use?

Use this rough guide:

- Use power limiting when the main concern is staying below a power limit.
- Use price shifting when the load can move to cheaper hours.
- Use daily budget when you want PELS to pace energy use across the day.
- Use Smart tasks when something must be ready by a specific time.
- Use Flow-booked cheap hours when you want Homey Flows to reserve specific cheap-hour windows.

Start here:

[Compare cost-saving functions](../cost-saving-functions.md)

## Related setup guides

For more information, see the [Getting Started](../getting-started.md), [Using Homey Energy](../homey-energy.md), [Compare cost-saving functions](../cost-saving-functions.md), [Smart Tasks](../smart-tasks.md), [Book cheap hours with Flows](../how-to-book-cheap-hours-with-flows.md), [Open configuration docs](../configuration.md), and [Flow Cards](../flow-cards.md) guides.
