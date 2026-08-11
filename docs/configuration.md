---
title: "Settings Guide — Limits, Devices, Modes & Prices"
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

Most configuration starts in **Settings**. The Settings landing page links to **Limits & safety**, **Devices**, **Modes**, **Electricity prices**, **Price-aware devices**, **Multiple meters**, **Simulation mode**, and **Advanced**.

## Overview

The Overview page shows the current plan: what PELS wants each managed device to do right now.

| Field | What it shows |
| --- | --- |
| **Power now** | Current whole-home power draw. |
| **Safe pace now** | The current pace PELS reacts around. It can come from the hourly hard cap, the daily budget, or both. |
| **Hard cap** | The hourly average power you don't want any hour to exceed (your grid tariff step). |
| **Device cards** | Running, Idle, Off, Limited, Resuming, Manual, Unavailable, or Unknown. |
| **Status line** | Short explanation of why PELS is waiting, limiting, or resuming. |

Use **Overview** when you want to understand live behavior. Use **Settings** when you want to change setup.

For the planner-state mapping, see [Plan States](/plan-states).

## Budget

The Budget page is the daily planning surface. It shows whether the selected day is on plan (**Plan** view) and lets you preview and apply changes to the daily budget model (**Adjust** view).

See [Daily Energy Budget](/daily-budget#where-to-configure-it) for the full description of each view and setting (Enable daily budget, Daily budget kWh, Use cheaper hours, Background usage reserve, Managed device flexibility). Read it before changing the advanced tuning values.

## Usage

The Usage page helps you understand what PELS has observed.

- **Today so far** shows hourly kWh for the selected local day.
- **Last 7 days** shows recent daily totals.
- **Typical day** shows historical hourly patterns.
- **Detailed hourly view** shows lower-level hourly buckets.
- **Solar** (shown when PELS has a solar signal) shows today's **Produced**, **Used at home**, and **Exported**, with the grid cost you avoided and what you earned from export. See [Solar and Self-Consumption](/solar).

The hourly bars split each hour into **managed** device usage and **background** usage, so you can see how much of your consumption PELS can influence.

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

![PELS Limits and safety settings showing Hard cap 8 kW, Safety margin 0.4 kW, the resulting safe pace, and the whole-home power source](/screenshots/settings/limits-safety.png)

| Setting | What it does |
| --- | --- |
| **Hard cap (kW)** | The hourly average power you don't want any hour to exceed. Set this from your grid tariff step (effekttrinn). |
| **Safety margin (kW)** | Buffer below the hard cap. PELS starts reacting before the hard cap is reached. |
| **Power source** | Where whole-home power readings come from: **Flow card** or **Power meter** (read through Homey Energy). |
| **Whole-home meter** | Shown with the Power meter source. Which meter whole-home power readings come from. **Automatic** uses the meter marked **Tracks total home energy consumption** in Homey Energy; you can instead pick a listed meter directly, even one without that marking. The list shows whole-home meters rather than every power-using device, so an EV charger or smart plug won't appear; a meter you chose earlier stays selectable even if it no longer appears. |

Important:

- The hourly hard cap is the only urgent safety boundary.
- The **Hard cap breach imminent — manual action needed** trigger fires only when PELS projects an hourly hard-cap breach and cannot limit any more load.

## Settings > Devices

The Devices page shows temperature devices, on-off devices, and supported EV chargers. Open a device to configure its detail panel.

![PELS Devices page with Managed, Limit, and Price toggles for an EV charger, heaters, and a thermostat](/screenshots/settings/devices.png)

Top-level controls:

| Control | What it means |
| --- | --- |
| **Managed** | PELS includes this device in modes and plans. Turn this on before using Limit or Price. |
| **Limit** | PELS may lower or turn off this device to stay under the hard cap. |
| **Price** | PELS adjusts the temperature target around electricity prices. |

Device detail sections. The page composes per device kind — an EV charger, a thermostat, a stepped load (such as a water heater), and a plain on/off device each lead with the sections that matter for that device, and sections that do not apply are not shown. The top of every managed device's page is a live status header: state, current draw, one fact line (temperature and target, or charging state, battery, and level), the reason the device is limited when it is, and a Smart task link when one is scheduled. A device PELS does not manage has no live status to report, so its page shows no header, and its Setup section starts expanded.

| Section | Shown for | What it contains |
| --- | --- | --- |
| **Charging** | EV chargers | The charging control readout (with a **Change** button that opens Setup), charge boost, and a statement of what limiting does (PELS pauses charging and resumes it when power allows). |
| **Car** | EV chargers | Which cars charge here, the battery level PELS reads from the car, and where the level comes from. |
| **Temperature per mode** | Temperature devices | Per-mode target temperatures, with each mode's resume priority (reordered in Modes). |
| **Price response** | Temperature devices | Cheap-hour boost and expensive-hour reduction. Stays visible with a hint naming the switch that enables it when price control is off. |
| **Solar surplus** (prosumer) | Homes with solar | **Use solar surplus** lifts a device's target while your panels are exporting, and **Run on solar surplus** runs an on/off device only while there is surplus. See [Solar and Self-Consumption](/solar). |
| **Stepped load profile** | Stepped loads | Step names, planning power values, target-power range, and temperature boost. Hidden for EV chargers using an EV preset — the preset owns the steps. |
| **Power limiting** | All devices PELS can limit | Turn off or set temperature / set step when there is a real choice; a device with only one possible action gets a statement of what PELS does instead of a one-button choice. |
| **Setup** | All devices | Managed by PELS, power-limit control, disable temperature control, leave off until turned on again, price-based control, budget exemption, built-in device control, control model, and **Power when running**. Opens automatically for devices that are not set up yet. |
| **Activity log** | All devices | Recent state changes PELS recorded for this device. |
| **Advanced diagnostics** | All devices | Read-only history of waiting time, failed restarts, and restart backoff. |

When a selected car is unavailable in Homey, PELS temporarily removes its association and
battery level because the retained car data cannot be trusted. The charger remains managed
normally. If the car becomes available again while both it and the charger still report a
connection, PELS resumes the association automatically; no physical replug is needed.

![PELS device detail page for a heat pump showing the live status header, Temperature per mode, Price response, Solar surplus, Power limiting, and the Setup section with Managed by PELS, Power-limit control, Control model, and Power when running](/screenshots/device-detail/mw-thermostat-heatpump-full.png)

Notes:

- Devices without a usable power estimate cannot use power-limit control.
- Temperature devices can still be managed for mode and price behavior even when power-limit control is unavailable.
- Turn on **Disable temperature control** when another app or Flow owns a thermostat's target. PELS keeps showing the measured temperature and target, but only turns the device off or on when managing capacity. Saved temperature settings remain available when temperature control is enabled again.
- **Built-in device control** lets PELS adjust a supported device (such as a compatible water heater) directly, without you wiring up Homey Flows, and is on by default for those devices. For compatible water heaters where PELS can choose between Flow wiring and built-in control, PELS leaves built-in device control off and shows a notice if one of your own Homey Flows already sets that device's power level or turns it on or off — remove that Flow to let PELS take over, or turn the switch on under the device's **Setup** section to override. EV chargers controlled through their native `target_power` capability do not have a separate built-in-control switch; avoid adding another Flow that writes the same current or power setting. A Flow that only reads the device, or only adjusts its temperature, is not a conflict.
- Only managed devices appear in **Settings > Modes**. Only managed temperature devices with **Price** enabled appear in **Settings > Price-aware devices**.
- **Power when running** is how much PELS assumes the device draws while it runs, and it decides how much power PELS frees up before resuming it. The field shows the figure PELS is using now and says where it came from — measured by PELS, read from the device, from Homey, or a rough estimate when PELS has no reading yet. Type a value in watts to correct it, or leave it empty to let PELS work it out. It is not shown for stepped loads, which are sized per configured step. If the figure looks wrong and you would rather fix it at the source, check **Device -> Advanced Settings -> Energy** in Homey and verify the configured power usage values.
- For EV current-control setup, see [Configure an EV Charger](/ev-charger).

### Leave off until turned on again

Off by default, and available for devices PELS can switch on and off.

When it is on and the device is turned off — in Homey, on the device itself, or
from another Flow — PELS leaves it off until it is turned on again. Turning the
device on again hands it straight back to normal PELS control. Devices PELS
turned off itself still resume on their own; this only applies to an off action
that did not come from PELS.

On the Overview the device reads **Off** with *Turned off elsewhere — turn it
on to resume*.

It is worth being clear about how this differs from turning **Power-limit
control** off, since both stop PELS resuming a device:

| | Power-limit control off | Leave off until turned on again |
| --- | --- | --- |
| May PELS limit the device? | No | Yes |
| May PELS resume it? | No, until you switch control back on | Yes, except while it has been switched off outside PELS |
| How does it go back to normal? | Re-enable Power-limit control | Turn the device on |
| What it is for | Handing the device to another automation entirely | A temporary override, by you or another automation |

Turning the device on gives control back to PELS; it does not promise the device
keeps running. If power is tight, PELS may limit it again right away.

One limitation worth knowing: PELS can only notice an off action that your
device's Homey integration reports back. A physical switch that does not tell
Homey it was pressed is invisible to PELS.

## Settings > Modes

Modes let you store different comfort and priority profiles such as **Home**, **Away**, **Night**, or **Vacation**.

![PELS Modes settings showing per-mode priority order and target temperatures, with drag handles to reorder priority](/screenshots/settings/modes.png)

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

### Export price (prosumer)

If you sell surplus solar back to the grid, turn on **Use an export price** and set a **share of the spot price** and/or a **fixed amount**. PELS then schedules against the blended **planning price** (what your energy is actually worth once export is accounted for), while your bills, receipts, and the budget's money view stay on the **import price** you are billed. This section appears only when you have a managed solar device or an export price already configured. See [Solar and Self-Consumption](/solar).

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
| **Simulation mode** | PELS shows what it would do, but Main home devices are not switched automatically. |

Use this while you are tuning priorities, power estimates, and limits. Turn it off when you are ready for PELS to control devices.

Simulation mode covers your Main home. Each [meter area](/meter-areas) has its own **Control devices in this area** switch under **Limits & safety**, so an area can keep limiting its devices while Simulation mode is on.

## Settings > Advanced

Advanced is for diagnostics, cleanup, and expert tuning.

| Setting | What it does |
| --- | --- |
| **Debug logging topics** | Chooses which internal topics emit debug logs. |
| **Reset usage history** | Clears hourly samples, daily totals, and weekday/weekend averages. |
| **Clear device data** | Removes stored PELS metadata for one selected device. |
| **Device log** | Writes a selected Homey device payload to the app logs for inspection. |

**Background usage reserve** and **Managed device flexibility** are edited in the Budget page's Adjust view (Budget shaping section), reachable from the Budget page header or the **Daily budget** row in Settings. Only change them if you understand the tradeoff — they can materially change when devices are limited and resumed.

For the exact formulas, see [Daily Budget Weighting Math](/daily-budget-weights).

## Suggested setup order

1. Get the meter Flow working.
2. Enable management on a small set of obvious devices.
3. Tune priorities and limits.
4. Add price-aware devices.
5. Add daily budget pacing if you want whole-day guidance.
6. Add Smart tasks for devices that must reach a target by a ready-by time.

For EV charging, add [EV charger current control](/ev-charger) after the meter Flow and capacity settings are working.
