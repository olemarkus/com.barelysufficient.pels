---
title: Flow Cards
description: What each PELS Homey Flow card does and which ones matter most for a working automation setup.
---

# Flow Cards

Flow cards are how PELS connects to the rest of your Homey setup.

If you only build one Flow, make it **Report power usage**. Everything else depends on having current load data unless you use **Homey Energy** as the power source.

Internal planner reasons may still mention older terms like "headroom" or "shed" in diagnostics and logs. In these docs and the visible UI, **headroom** is **available power** (how much more load PELS can fit before the current safe pace) and **shed** appears as **limited**. Legacy flow-card filenames such as `has_headroom_for_device` keep their stable internal ids; their visible titles use the current vocabulary.

## Required Starter Flow

### Report power usage

Use the **Report power usage** action whenever your power meter updates.

- Input is current power in **watts**.
- This is the data PELS uses to track hourly usage, calculate available power, and decide whether devices should be limited or resumed.
- You do not need this Flow when **Settings > Limits & safety > Power source** is set to **Homey Energy**.

Without whole-home power data, the planner cannot behave correctly.

## Triggers

| Card | What it does |
| --- | --- |
| **Capacity guard: manual action needed** | Fires when PELS projects that your hourly hard-cap budget will be breached at the current run rate and no more devices can be limited. |
| **Operating mode changed to...** | Fires when the current PELS operating mode changes to the selected mode. |
| **Price level changed to...** | Fires when the price level changes between Cheap, Normal, Expensive, or Unknown. |
| **Current price is one of today's lowest** | Fires when the current hour is among the selected number of cheapest hours today. |
| **Current price is one of the lowest before a time** | Fires when the current hour is among the selected number of cheapest hours in a window before a chosen end hour. |
| **Desired stepped load changed for** | Fires when PELS wants a stepped-load device, including EV charger control modes, to move to another configured step. |
| **Smart task status changed** | Fires when PELS re-evaluates a Smart task for a device and the status changes, such as **On track** to **At risk**. |
| **Smart task plan changed** | Fires when the scheduled hours for a Smart task are revised, for example after new prices arrive. |
| **Smart task ended** | Fires once when a task run concludes. The **Outcome** tag is `succeeded`, `missed`, or `abandoned`. Filter on the tag downstream — for example, send a notification only when `Outcome = missed`. |
| **PELS price list was updated** | Fires when today's or tomorrow's adjusted prices change in a way that matters (new day-ahead prices arrived, grid tariffs re-fetched, local midnight rollover). Exposes a `prices_json` token with the full hourly array. See [Price Tags in Flow & HomeyScript](/price-tags). |

Use **Capacity guard: manual action needed** for urgent notifications, not for normal daily pacing.

## Conditions

| Card | What it does |
| --- | --- |
| **Is there enough available power?** | Checks whether current available power can fit a specified extra load in kW. |
| **Is there available power for device?** | Checks whether current available power can fit the selected device's estimated draw plus a specified extra load. Useful for stepped devices. |
| **Operating mode is...** | Checks which mode is active. |
| **Price level is...** | Checks the current price bucket. |
| **Current price is one of today's lowest** | True when the current hour is among the selected number of cheapest hours today. |
| **Current price is one of the lowest before a time** | True when the current hour is among the selected number of cheapest hours in a window before a chosen end hour. |
| **Is device managed by PELS?** | Checks whether PELS currently manages the selected device. |
| **Is power-limit control enabled for device?** | Checks whether power-limit control is enabled for the selected device. |
| **Does device have budget exemption?** | Checks whether the selected device is ignored by daily-budget control while still counting in real usage and hourly hard-cap protection. |
| **Smart task status is...** | True when the current Smart task status for the chosen device matches **Building plan…**, **Queued**, **Paused — unplugged**, **On track**, **At risk**, **Cannot finish**, or **Satisfied**. |
| **Has smart task** | True when the device has a stored Smart task. |

The device-aware available-power condition includes built-in hysteresis after recent limiting or resume events on the same device.

## Actions

| Card | What it does |
| --- | --- |
| **Report power usage** | Feeds live meter data into PELS. Required unless the power source is Homey Energy. |
| **Set capacity limit** | Changes the configured hard cap dynamically. |
| **Set operating mode** | Switches between stored modes such as Home or Night. |
| **Set daily budget** | Sets the daily budget from a Flow. Use `0` to disable daily budget. |
| **Add budget exemption for device** | Makes a device skip daily-budget control. Real usage still counts in charts and hourly hard-cap protection. |
| **Remove budget exemption for device** | Makes a device follow daily-budget control again. |
| **Enable power-limit control for device** | Turns on power-limit control for one device. |
| **Disable power-limit control for device** | Turns off power-limit control for one device. |
| **Set expected power for device** | Legacy/manual override of a device's expected draw in watts. Fails if the device already has configured load or a stepped-load profile. |
| **Set external prices (today)** | Stores today's hourly prices from a Flow tag payload. |
| **Set external prices (tomorrow)** | Stores tomorrow's hourly prices from a Flow tag payload. |
| **Report stepped load** as **step** | Reports the selected stepped-load level directly, usually after a vendor-specific action card. |
| **Report stepped load** matching **power** | Reports a power value and lets PELS match it to the configured stepped-load planning power. Accepts values such as `1750` or `1750 W`. |
| **Report battery level for charger** | Stores battery percentage for a managed charger when the car or charger app exposes that value. Used by charge boost and charging Smart tasks. |
| **Add heating task** | Stores a target temperature and ready-by time for a temperature device. PELS picks useful cheaper hours before the ready-by time. |
| **Add charging task** | Stores a target battery percentage and ready-by time for an EV charger. |
| **Clear smart task** | Removes any active Smart task for a device. |

## Common Automation Patterns

### Mode switching

Use **Set operating mode** from schedules or presence events to move between comfort profiles without changing every device manually.

### Daily-budget automation

Use **Set daily budget** when the daily target should vary by season, tariff, occupancy, or manual Homey controls.

Use **Add budget exemption for device** for a device that should not cause other devices to be limited just to compensate for its daily energy use. Exempt devices still count in real usage and hourly hard-cap protection.

### Device state checks

Use the device-state conditions to avoid duplicate actions:

| Goal | Condition |
| --- | --- |
| Only enable control when a device is managed | **Is device managed by PELS?** |
| Check whether a Flow-booked device is currently allowed | **Is power-limit control enabled for device?** |
| Check whether daily-budget control currently ignores a device | **Does device have budget exemption?** |

### Stepped load control

For water heaters and similar non-EV devices using the built-in stepped-load model:

1. Configure the step list in the PELS device settings.
2. Use **Desired stepped load changed for [device]** to map PELS intent to vendor actions.
3. Report the resulting step back through one of the stepped-load feedback cards.

The full worked example lives in [Wire a Flow-Based Load Device](/how-to-headroom-expected-power-flow-control).

For EV chargers, prefer the EV charger control mode and wire the **EV charger current (A)** tag directly to the charger app's available-current action. See [Configure an EV Charger](/ev-charger). Zaptec-specific notes live in [Configure a Zaptec EV Charger](/zaptec-ev-charger).

### EV battery reporting

Use **Report battery level for charger** when a car or charger app reports battery percentage. This is optional for basic current control, but it is needed for charge boost and charging Smart tasks that depend on battery progress.

### Smart tasks

Use Smart task cards when one device should reach a target by a ready-by time.

| Goal | Action card |
| --- | --- |
| Charge an EV to a target battery percentage | **Add charging task** |
| Heat a temperature device to a target temperature | **Add heating task** |
| Remove the current task for a device | **Clear smart task** |

Use **Smart task status changed** for notifications, **Smart task plan changed** when you care that the scheduled hours moved, and **Has smart task** when another Flow should behave differently while a task is active.

See [Smart Tasks](/smart-tasks) for setup examples.

### Book cheap hours before a time

Use **Current price is one of the lowest before a time** when you want a Flow to allow a device during a fixed number of cheap hours before a ready-by-style end time.

Example:

| Argument | Value |
| --- | --- |
| **Hours** | `12` |
| **Lowest count** | `5` |
| **End hour** | `7` |

This matches the 5 cheapest hours in the 12 hours before 07:00. The window can cross midnight.

Pair that condition or trigger with **Enable power-limit control for device** and **Disable power-limit control for device** so your Flow chooses the booked hours while PELS still protects the hard cap.

See [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows).

### Price feed import

If you use an external price provider:

1. Send the full-day JSON for today to **Set external prices (today)**.
2. Send tomorrow's full-day JSON to **Set external prices (tomorrow)**.
3. Let PELS use whichever price window is currently available.

## Units To Keep Straight

- Available-power checks use **kW**.
- Expected power overrides use **W**.
- Hourly and daily budget values use **kWh**.
- EV charger current tags use **A**.

Mixing these units is the most common Flow mistake.
