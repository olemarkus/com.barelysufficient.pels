---
title: Configuration
description: What each PELS settings tab does and which controls matter most for a reliable setup.
---

# Configuration

The PELS settings UI is organized by task. Most users spend the most time in **Devices**, **Modes**, **Budget**, and **Price**.

## Devices tab

The Devices tab shows temperature devices, on-off devices, and optionally supported EV chargers.

- EV chargers are hidden by default and only appear after enabling **Enable EV charger support** in the Advanced tab.
- Devices without a usable power estimate cannot be capacity-controlled.
- Temperature devices can still be managed for mode and price behavior even when capacity control is unavailable.

| Setting | What it does |
| --- | --- |
| **Managed by PELS** | Includes the device in modes and price optimization. Unmanaged devices stay out of the Overview plan and are treated as uncontrolled load. |
| **Capacity-based control** | Allows PELS to shed and restore the device for capacity. Requires a usable power estimate. |
| **Price optimization** | Applies cheap-hour or expensive-hour temperature deltas on managed temperature devices. |
| **When shedding** | Chooses whether PELS turns the device off or drops it to a configured minimum temperature. |

Notes:

- Only managed devices appear in the Modes tab and price-optimization list.
- If expected usage looks wrong, check **Device -> Advanced Settings -> Energy** in Homey and verify the configured power usage values.
- EV charger support is currently limited to official Homey EV chargers exposing `evcharger_charging` and `evcharger_charging_state`.

## Modes tab

Modes let you store different comfort and priority profiles such as **Home**, **Away**, **Night**, or **Vacation**.

### What changes per mode

For each managed device in a mode:

| Setting | What it does |
| --- | --- |
| **Desired deg C** | Target temperature for the mode |
| **Priority** | Lower number means higher priority. These devices stay on longer and restore first. |

Typical approach:

- Keep living-room comfort high in **Home** mode.
- Move bedroom heating higher during **Night** mode.
- Lower less critical loads in **Away** mode.

Changes save automatically.

## Overview tab

The Overview tab shows the current plan: what PELS wants each managed device to do right now.

| Field | What it shows |
| --- | --- |
| **Device** | Device name |
| **Temperature** | Current and target temperature where relevant |
| **Power** | Current to planned on-off state |
| **State** | Active, Restoring, Shed, Inactive, or Capacity control off |
| **Usage** | Current measured power and expected power |
| **Status** | The reason for the current plan or current blocker |

Use **Refresh plan** after changing setup if you want an immediate recalculation.

For the exact planner state language, see [Plan States](/plan-states).

## Budget tab

This is where the core capacity logic lives.

### Capacity settings

| Setting | What it does |
| --- | --- |
| **Capacity limit (kW)** | Your hourly hard-cap limit. This is the line you do not want to average above for the current hour. |
| **Soft margin (kW)** | Buffer below the hard cap. PELS starts reacting before you hit the hard-cap budget. |
| **Dry run** | Calculates the plan without actually controlling devices. Useful during initial tuning. |

Important:

- The hourly capacity limit is the only real emergency limit.
- The **Capacity guard: manual action needed** trigger only fires when PELS projects an hourly hard-cap breach and cannot shed any more load.

### Daily budget

The daily budget is a soft pacing layer on top of hourly control.

- It never replaces the hourly hard cap.
- It never triggers shortfall alarms by itself.
- It can reduce restores earlier in the day if you are already over plan.

Read [Daily Energy Budget](/daily-budget) before changing the advanced tuning values.

## Usage tab

The Usage tab helps you understand what PELS has observed.

- **Usage summary** shows today, the last week, and the last month.
- **Usage patterns** show a heatmap of typical load by weekday and hour.
- **Hourly totals** show derived hourly energy use based on reported power samples.

This is useful when you want to see whether your meter Flow is healthy and whether your home follows a stable pattern.

## Price tab

Price support is optional, but it makes the app more useful for thermal loads.

### Price source

| Setting | What it does |
| --- | --- |
| **Price source** | Choose **Norway (spot + grid tariff)**, **Homey Energy**, or **Flow tag**. |

If you use Norway pricing, you also set:

- county
- grid company
- tariff group
- price area
- provider surcharge
- threshold and minimum difference values

If you use external flow tags:

1. Set **Price source** to **Flow tag**.
2. Feed the full JSON payload for today's prices into **Set external prices (today)**.
3. Feed tomorrow's payload into **Set external prices (tomorrow)** when available.

### Price optimization per device

| Setting | What it does |
| --- | --- |
| **Cheap delta** | Temperature boost during cheap hours |
| **Expensive delta** | Temperature reduction during expensive hours |

Water heaters and similar thermal loads are usually the best first candidates.

## Advanced tab

The Advanced tab is for optional capabilities and expert tuning.

| Setting | What it does |
| --- | --- |
| **Enable EV charger support** | Shows supported EV chargers and allows pause-resume control through EV capabilities. |
| **Debug logging topics** | Chooses which internal topics emit debug logs. |
| **Controlled usage weight** | Tunes how strongly controlled usage influences the learned daily profile. |
| **Price flex share** | Tunes how strongly price shaping can move controlled usage across the day. |
| **Show daily budget breakdown in chart** | Splits the plan chart into controlled and uncontrolled portions. |

Only change the daily-budget tuning values if you understand the tradeoff. They can materially change shed timing and restore timing.

For the exact formulas, see [Daily Budget Weighting Math](/daily-budget-weights).

## Suggested setup order

1. Get the meter Flow working.
2. Enable management on a small set of obvious devices.
3. Tune priorities and capacity settings.
4. Add price optimization.
5. Add daily budget pacing if you want softer whole-day guidance.
