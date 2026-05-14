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
- This is the data PELS uses to track hourly usage, calculate available power, and decide whether devices should be limited or resumed

Without this action, the planner cannot behave correctly.

## Triggers

| Card | What it does |
| --- | --- |
| **Capacity guard: manual action needed** | Fires when PELS projects that your hourly hard-cap budget will be breached at the current run rate and no more devices can be limited. |
| **Operating mode changed to...** | Fires when the current PELS operating mode changes to the selected mode. |
| **Price level changed to...** | Fires when the price level changes between Cheap, Normal, Expensive, or Unknown. |
| **Current price is one of today's lowest** | Fires when the current hour is among the selected number of cheapest hours today. |
| **Current price is one of the lowest before a time** | Fires when the current hour is among the selected number of cheapest hours in a window before a chosen end hour. |
| **Smart task status changed** | Fires when PELS re-evaluates a Smart task for a device and the status changes, such as **On track** to **At risk**. |
| **Smart task missed** | Fires the next time PELS evaluates a Smart task that has already passed without reaching its target. |

Use **Capacity guard: manual action needed** for urgent notifications, not for normal daily pacing.

## Conditions

| Card | What it does |
| --- | --- |
| **Is there enough headroom?** | Checks if the current available power can fit a specified extra load in kW. |
| **Is there headroom for device?** | Checks if current available power can fit the device's estimated draw plus a specified extra load. Useful for stepped devices. |
| **Operating mode is...** | Checks which mode is active. |
| **Price level is...** | Checks the current price bucket. |
| **Current price is one of today's lowest** | True when the current hour is among the selected number of cheapest hours today. |
| **Current price is one of the lowest before a time** | True when the current hour is among the selected number of cheapest hours in a window before a chosen end hour. |
| **Smart task status is...** | True when the current Smart task status for the chosen device matches the chosen status: **Waiting**, **On track**, **At risk**, **Cannot finish**, or **Satisfied**. |
| **Has smart task** | True when the device has a stored Smart task. |

The device-aware condition already includes built-in hysteresis after recent limiting or resume events on the same device.

## Actions

| Card | What it does |
| --- | --- |
| **Report power usage** | Feeds live meter data into PELS. Required. |
| **Set capacity limit** | Changes the configured hard-cap limit dynamically. |
| **Set operating mode** | Switches between stored modes such as Home or Night. |
| **Set expected power for device** | Temporarily sets a device's expected draw in watts. Fails if the device already has a configured `settings.load`. |
| **Enable capacity control for device** | Turns on power-limit control for one device. |
| **Disable capacity control for device** | Turns off power-limit control for one device. |
| **Set external prices (today)** | Stores today's hourly prices from a Flow tag payload. |
| **Set external prices (tomorrow)** | Stores tomorrow's hourly prices from a Flow tag payload. |
| **Add heating task** | Stores a target temperature and ready-by time for a temperature device. PELS picks useful cheaper hours before the ready-by time. |
| **Add charging task** | Stores a target battery percentage and ready-by time for an EV charger. |
| **Clear smart task** | Removes any active Smart task for a device. |

## Common automation patterns

### Mode switching

Use **Set operating mode** from schedules or presence events to move between comfort profiles without changing every device manually.

### Stepped load control

For water heaters and similar non-EV devices using the built-in stepped-load model:

1. Configure the step list in the PELS device settings.
2. Use **Desired stepped load changed for [device]** to map PELS intent to vendor actions.
3. Report the resulting step back through one of the stepped-load feedback cards.

The full worked example lives in [Wire a Flow-Controlled Load Device](/how-to-headroom-expected-power-flow-control).

For EV chargers, prefer the EV charger control mode and wire the **EV charger current (A)** tag directly to the charger app's available-current action. See [Configure an EV Charger](/ev-charger). Zaptec-specific notes live in [Configure a Zaptec EV Charger](/zaptec-ev-charger).

### Smart tasks

Use Smart task cards when one device should reach a target by a ready-by time.

| Goal | Action card |
| --- | --- |
| Charge an EV to a target battery percentage | **Add charging task** |
| Heat a temperature device to a target temperature | **Add heating task** |
| Remove the current task for a device | **Clear smart task** |

Use **Smart task status changed** for notifications and **Has smart task** when another Flow should behave differently while a task is active.

See [Smart Tasks](/smart-tasks) for setup examples.

### Book cheap hours before a time

Use **Current price is one of the lowest before a time** when you want a Flow to allow a device during a fixed number of cheap hours before a deadline-like end time.

Example:

| Argument | Value |
| --- | --- |
| **Hours** | `12` |
| **Lowest count** | `5` |
| **End hour** | `7` |

This matches the 5 cheapest hours in the 12 hours before 07:00. The window can cross midnight.

Pair that condition or trigger with **Enable capacity control for device** and **Disable capacity control for device** so your Flow chooses the booked hours while PELS still protects the hard cap.

See [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows).

### Price feed import

If you use an external price provider:

1. Send the full-day JSON for today to **Set external prices (today)**.
2. Send tomorrow's full-day JSON to **Set external prices (tomorrow)**.
3. Let PELS use whichever price window is currently available.

## Units to keep straight

- Available-power checks use **kW**
- Expected power overrides use **W**
- Hourly and daily budget values use **kWh**

Mixing these units is the most common Flow mistake.
