---
title: Use Home, Away and Night modes for energy behavior
description: Use PELS modes with Homey Flows to change comfort targets, priorities and energy behavior when you are home, away or asleep.
---

# Use Home, Away and Night modes for energy behavior

Homey can know when people are home, away or asleep. PELS can use that state to change how energy is managed.

Instead of rebuilding every Flow for every routine, use PELS modes. A mode can have different comfort targets, priorities and energy behavior. Homey Flows can then switch PELS between Home, Away and Night.

## When this is useful

Use modes when you want the home to behave differently depending on the situation:

- stricter comfort when people are home
- lower heating or more flexible timing when away
- cheaper-hour bias during the night
- different priorities for EV charging, heating, hot water and ventilation
- simpler Flows that only switch the active PELS mode

This keeps the logic in one place. Homey decides when the mode changes. PELS decides how managed devices behave in that mode.

## What PELS modes do

A PELS mode can change how devices are treated. For example:

- heating can have different comfort targets
- some devices can become more or less flexible
- priorities can change
- price shifting can be more or less aggressive
- Smart tasks can still protect ready-by goals

The hard cap still applies. Modes do not override the configured power limit.

## Example: Home mode

Home mode is usually the comfort-first mode.

Typical behavior:

- normal heating targets
- hot water has normal priority
- EV charging can run when there is room
- price shifting is useful, but should not make the home uncomfortable

Use Home mode when people are present and comfort matters.

## Example: Away mode

Away mode can be more flexible.

Typical behavior:

- lower heating targets
- more willingness to wait for cheap hours
- EV charging can continue if it needs to be ready later
- hot water may be lower priority unless a Smart task says otherwise

Use Away mode when nobody is home and comfort can be relaxed.

## Example: Night mode

Night mode is often useful for cheap-hour planning.

Typical behavior:

- relaxed room comfort in unused rooms
- EV charging or hot water can run if cheap and there is room
- heating can prepare for morning if needed
- noisy or intrusive devices may need lower priority depending on the home

Use Night mode when the home can tolerate more flexible timing, but some things must be ready by morning.

## Switching modes from Homey Flows

Homey Flows are the normal way to switch PELS modes.

Example Flow ideas:

- When everyone leaves, set PELS mode to Away.
- When someone comes home, set PELS mode to Home.
- At 23:00, set PELS mode to Night.
- Before morning, use Smart tasks for rooms, EV charging or hot water that must be ready.

Keep presence detection in Homey. Keep energy behavior in PELS.

## Modes and Smart tasks

Modes describe the normal behavior of the home.

Smart tasks describe a specific goal with a target and ready-by time.

For example:

- Away mode can lower normal heating.
- A Smart task can still warm a room before you come home.
- Night mode can allow cheaper-hour charging.
- A Smart task can still require the EV to be ready by morning.

This is usually better than making many separate Homey Flows for every device and situation.

## What you need

You normally need:

- configured PELS modes
- Homey Flows that decide when to switch modes
- controllable devices in PELS
- priorities that make sense for each routine
- Smart tasks for specific ready-by goals

PELS does not need to know why a mode changed. Homey can use presence, time, manual buttons, calendar logic or other automations to choose the active mode.

## Related setup guides

For more information, see the [Getting Started](../getting-started.md), [Using Homey Energy](../homey-energy.md), [Compare cost-saving functions](../cost-saving-functions.md), [Smart Tasks](../smart-tasks.md), [Open configuration docs](../configuration.md), and [Flow Cards](../flow-cards.md) guides.
