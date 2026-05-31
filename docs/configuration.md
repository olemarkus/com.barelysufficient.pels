---
title: Configuration
description: What each PELS settings page does and which controls matter most for a reliable setup.
---

# Configuration

The PELS settings UI is organized around five top-level destinations:

| Destination | Use for |
| --- | --- |
| **Overview** | Current power, safe pace, hard cap, and what PELS is doing right now. |
| **Budget** | Daily budget plan, today/tomorrow planning, and budget adjustments. |
| **Usage** | Hourly and daily energy history. |
| **Smart tasks** | Current and past ready-by tasks. |
| **Settings** | Limits, devices, modes, prices, simulation, and advanced tools. |

Most configuration starts in **Settings**. The Settings landing page links to **Limits & safety**, **Devices**, **Modes**, **Electricity prices**, **Price-aware devices**, **Simulation mode**, and **Advanced**.

## Overview

The Overview page shows the current plan: what PELS wants each managed device to do right now.

| Field | What it shows |
| --- | --- |
| **Power now** | Current whole-home power draw. |
| **Safe pace now** | The current pace PELS reacts around. It can come from the hourly hard cap, the daily budget, or both. |
| **Hard cap** | The configured upper boundary PELS tries not to exceed. |
| **Device cards** | Running, Idle, Limited, Resuming, Manual, Unavailable, or Unknown. |
| **Status line** | Short explanation of why PELS is waiting, limiting, or resuming. |

Use **Overview** when you want to understand live behavior. Use **Settings** when you want to change setup.

For the planner-state mapping, see [Plan States](/plan-states).

## Budget

The Budget page is the daily planning surface. It shows whether the selected day is on plan (**Plan** view) and lets you preview and apply changes to the daily budget model (**Adjust** view).

See [Daily Energy Budget](/daily-budget#where-to-configure-it) for the full description of each view and setting (Enable daily budget, Daily budget kWh, Use cheaper hours, Background usage reserve, Managed device flexibility). Read it before changing the advanced tuning values.

## Usage

The Usage page helps you understand what PELS has observed.

- **Today so far** shows hourly kWh for the selected local day.
- **Last 14 days** shows recent daily totals.
- **Typical day** shows historical hourly patterns.
- **Detailed hourly view** shows lower-level hourly buckets.

Hourly data is kept for 30 days. Daily totals are kept for one year. Resetting usage history lives under **Settings > Advanced > Data management**.

## Smart Tasks

Smart tasks show devices with an active target and ready-by time. Tasks are created from Homey Flow cards or the **New smart task** dashboard widget, then shown in the settings UI so you can inspect the current plan and history.

| Card or view | What it does |
| --- | --- |
| **Add charging task** | Plans EV charging toward a target battery percentage by a ready-by time. |
| **Add heating task** | Plans heating toward a target temperature by a ready-by time. |
| **New smart task widget** | Creates a task from a Homey dashboard, without a Flow. |
| **Smart tasks list** | Shows current tasks, targets, and ready-by times. |
| **Task plan page** | Shows selected hours, price context, expected work, background usage, and progress. |
| **History** | Shows previous task outcomes. |

See [Smart Tasks](/smart-tasks) for behavior details and [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows) if you prefer a fixed number of cheapest hours instead of a target-based task.

## Settings > Limits & Safety

This is where the core capacity settings and whole-home power source live.

| Setting | What it does |
| --- | --- |
| **Hard cap (kW)** | The upper boundary PELS tries not to exceed. Set this from your grid tariff step or breaker limit. |
| **Safety margin (kW)** | Buffer below the hard cap. PELS starts reacting before the hard cap is reached. |
| **Power source** | Where whole-home power readings come from: **Flow card** or **Homey Energy**. |

Important:

- The hourly hard cap is the only urgent safety boundary.
- The **Capacity guard: manual action needed** trigger fires only when PELS projects an hourly hard-cap breach and cannot limit any more load.

## Settings > Devices

The Devices page shows temperature devices, on-off devices, and supported EV chargers. Open a device to configure its detail panel.

Top-level controls:

| Control | What it means |
| --- | --- |
| **Managed** | PELS includes this device in modes and plans. Turn this on before using Limit or Price. |
| **Limit** | PELS may lower or turn off this device to stay under the hard cap. |
| **Price** | PELS adjusts the temperature target around electricity prices. |

Device detail sections:

| Section | What it contains |
| --- | --- |
| **Temperature per mode** | Per-mode target temperatures for temperature devices. |
| **Price response** | Cheap-hour boost and expensive-hour reduction. |
| **Power limiting** | What PELS does when power needs to be lowered: turn off, set temperature, or set stepped-load level. |
| **Stepped load profile** | Step names, planning power values, target-power range, temperature boost, and charge boost where supported. |
| **Setup** | Managed by PELS, power-limit control, price-based control, budget exemption, built-in device control, control model, and battery level. |
| **Advanced diagnostics** | Read-only blocked time, activation instability, and penalty history. |

Notes:

- Devices without a usable power estimate cannot use power-limit control.
- Temperature devices can still be managed for mode and price behavior even when power-limit control is unavailable.
- **Built-in device control** lets PELS adjust a supported device (such as a compatible water heater) directly, without you wiring up Homey Flows, and is on by default for those devices. For compatible water heaters where PELS can choose between Flow wiring and built-in control, PELS leaves built-in device control off and shows a notice if one of your own Homey Flows already sets that device's power level or turns it on or off — remove that Flow to let PELS take over, or turn the switch on under the device's **Setup** section to override. EV chargers controlled through their native `target_power` capability do not have a separate built-in-control switch; avoid adding another Flow that writes the same current or power setting. A Flow that only reads the device, or only adjusts its temperature, is not a conflict.
- Only managed devices appear in **Settings > Modes**. Only managed temperature devices with **Price** enabled appear in **Settings > Price-aware devices**.
- If expected usage looks wrong, check **Device -> Advanced Settings -> Energy** in Homey and verify the configured power usage values.
- For EV current-control setup, see [Configure an EV Charger](/ev-charger).

## Settings > Modes

Modes let you store different comfort and priority profiles such as **Home**, **Away**, **Night**, or **Vacation**.

### What changes per mode

For each managed device in a mode:

| Setting | What it does |
| --- | --- |
| **Desired temperature** | Target temperature for the mode |
| **Priority** | Lower number means higher priority. These devices stay on longer and resume first. |

Typical approach:

- Keep living-room comfort high in **Home** mode.
- Move bedroom heating higher during **Night** mode.
- Lower less critical loads in **Away** mode.

Changes save automatically.

## Settings > Electricity Prices

Price support is optional, but it makes the app more useful for thermal loads, daily budget price shaping, Smart tasks, and cheapest-hour Flow cards.

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

## Settings > Price-Aware Devices

This page adjusts devices that already have price response enabled. To add a device here, first open the device under **Settings > Devices** and enable **Price** or **Setup > Price-based control**.

| Setting | What it does |
| --- | --- |
| **Respond to prices** | Enables or disables price response globally. |
| **Cheap-hour boost (°C)** | Temperature boost during cheap hours. |
| **Expensive-hour reduction (°C)** | Temperature reduction during expensive hours. |

Water heaters and similar thermal loads are usually the best first candidates.

## Settings > Simulation Mode

Simulation mode lets you test behavior without switching devices.

| Setting | What it does |
| --- | --- |
| **Simulation mode** | PELS shows what it would do, but devices are not switched automatically. |

Use this while you are tuning priorities, power estimates, and limits. Turn it off when you are ready for PELS to control devices.

## Settings > Advanced

Advanced is for diagnostics, cleanup, and expert tuning.

| Setting | What it does |
| --- | --- |
| **Debug logging topics** | Chooses which internal topics emit debug logs. |
| **Background usage reserve** | Tunes how much daily budget PELS holds back for household usage it cannot move. |
| **Managed device flexibility** | Tunes how freely PELS may shift managed-device usage toward cheaper feasible hours. |
| **Show daily budget breakdown in chart** | Splits the plan chart into managed and background portions. |
| **Reset usage history** | Clears hourly samples, daily totals, and weekday/weekend averages. |
| **Clear device data** | Removes stored PELS metadata for one selected device. |
| **Device log** | Writes a selected Homey device payload to the app logs for inspection. |

Only change the daily-budget tuning values if you understand the tradeoff. They can materially change when devices are limited and resumed.

For the exact formulas, see [Daily Budget Weighting Math](/daily-budget-weights).

## Suggested setup order

1. Get the meter Flow working.
2. Enable management on a small set of obvious devices.
3. Tune priorities and limits.
4. Add price-aware devices.
5. Add daily budget pacing if you want whole-day guidance.
6. Add Smart tasks for devices that must reach a target by a ready-by time.

For EV charging, add [EV charger current control](/ev-charger) after the meter Flow and capacity settings are working.
