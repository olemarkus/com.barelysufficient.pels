---
title: Flow Cards
description: What each PELS Homey Flow card does and which ones matter most for a working automation setup.
---

# Flow Cards

Flow cards are how PELS connects to the rest of your Homey setup.

If you only build one Flow, make it **Report power usage**. Everything else depends on having current load data.

## Required starter Flow

### Report power usage

Use the **Report power usage** action whenever your power meter updates.

- Input is current power in **watts**
- This is the data PELS uses to track hourly usage, calculate headroom, and decide whether devices should be shed or restored

Without this action, the planner cannot behave correctly.

## Triggers

| Card | What it does |
| --- | --- |
| **Capacity guard: manual action needed** | Fires when PELS projects that your hourly hard-cap budget will be breached at the current run rate and no controllable devices are left to shed. |
| **Operating mode changed to...** | Fires when the current PELS operating mode changes to the selected mode. |
| **Price level changed to...** | Fires when the price level changes between Cheap, Normal, Expensive, or Unknown. |

Use the shortfall trigger for urgent notifications, not for normal daily pacing.

## Conditions

| Card | What it does |
| --- | --- |
| **Is there enough headroom?** | Checks if the current headroom can fit a specified extra load in kW. |
| **Is there headroom for device?** | Checks if current headroom plus the device's estimated draw can fit an extra load. Useful for stepped devices. |
| **Operating mode is...** | Checks which mode is active. |
| **Price level is...** | Checks the current price bucket. |

The device-aware headroom condition already includes built-in hysteresis after recent shed or restore events on the same device.

## Actions

| Card | What it does |
| --- | --- |
| **Report power usage** | Feeds live meter data into PELS. Required. |
| **Set capacity limit** | Changes the configured hard-cap limit dynamically. |
| **Set operating mode** | Switches between stored modes such as Home or Night. |
| **Set expected power for device** | Temporarily sets a device's expected draw in watts. Fails if the device already has a configured `settings.load`. |
| **Enable capacity control for device** | Turns on capacity-based control for one device. |
| **Disable capacity control for device** | Turns off capacity-based control for one device. |
| **Set external prices (today)** | Stores today's hourly prices from a Flow tag payload. |
| **Set external prices (tomorrow)** | Stores tomorrow's hourly prices from a Flow tag payload. |

## Common automation patterns

### Mode switching

Use **Set operating mode** from schedules or presence events to move between comfort profiles without changing every device manually.

### Stepped load control

For EV chargers, water heaters, and similar devices using the built-in stepped-load model:

1. Configure the step list in the PELS device settings.
2. Use **Desired stepped load changed for [device]** to map PELS intent to vendor actions.
3. Report the resulting step back through one of the stepped-load feedback cards.

The full worked example lives in [Wire a stepped load device](/how-to-headroom-expected-power-flow-control).

### Price feed import

If you use an external price provider:

1. Send the full-day JSON for today to **Set external prices (today)**.
2. Send tomorrow's full-day JSON to **Set external prices (tomorrow)**.
3. Let PELS use whichever price window is currently available.

## Units to keep straight

- Headroom checks use **kW**
- Expected power overrides use **W**
- Hourly and daily budget values use **kWh**

Mixing these units is the most common Flow mistake.
