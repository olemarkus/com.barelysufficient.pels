---
title: PELS Insights Device
description: Chart PELS over weeks in Homey Insights, read its live values in Flows and other apps, and switch mode from a device tile.
---

# PELS Insights Device

PELS includes a virtual device called **PELS Insights**. It publishes what PELS is doing as device readings, which gives you three things:

- **History.** Homey Insights logs the numeric and yes/no readings, so you can chart available power, managed and background usage, and energy per capacity period over weeks and months.
- **Values for Flows and other apps.** Advanced Flow logic, HomeyScript, dashboards and bridges to other systems can read any reading, such as **Available power** as a number.
- **A mode switch on a tile.** Tap **Mode** on the device tile to change the PELS mode.

For a quick look at the current state on a Homey dashboard, the [widgets](/widgets) show more and update live.

## Add the device

1. Open **Devices -> Add Device**
2. Select **PELS**
3. Choose **PELS Insights**
4. Add the device

## What it shows

The labels below match the readings shown in Homey.

| Reading | Meaning |
| --- | --- |
| **Mode** | Current PELS mode. Tap the tile to switch, or change it in settings or a Flow |
| **Manual action needed** | Whether PELS projects a hard-cap breach in the current capacity period and cannot limit any more load |
| **Available power** | Extra power PELS can fit before the current safe pace; empty while every power limit is off |
| **Current safe pace** | Current effective pace used for power limiting; empty while every power limit is off |
| **Used this hour** | Energy used so far in the current clock hour |
| **Used this capacity period** | Energy used so far in the current capacity period, the hour or the quarter the hard cap is judged against |
| **Daily budget remaining** | Remaining daily budget, when the daily budget is on |
| **Daily budget exceeded** | Whether the daily plan is currently over target |
| **Limit reason** | Which limit is holding devices back: **Not limiting**, **Capacity limit**, **Daily budget**, **Grid import limit** or **Several limits** |
| **Managed device usage** | Power currently being drawn by managed devices |
| **Background usage** | Power currently being drawn outside managed devices |
| **Price level** | Current price level: cheap, normal or expensive |
| **Devices active** | Number of managed devices not currently limited |
| **Devices limited** | Number of managed devices currently limited |

While the power meter is silent, **Available power**, **Managed device usage** and **Background usage** are empty rather than showing the last reading.

## Examples

- Chart **Background usage** over a winter month to see how much of your load PELS can never move.
- Chart **Used this capacity period** next to your hard cap to see how often you come close.
- In an Advanced Flow, compare **Available power** with what a device needs before you start it.

## What the hard-cap breach alarm means

**Manual action needed** is intentionally strict.

- It only applies to projected **hard-cap** breaches in the current capacity period (the hour, or the quarter on the 15-minute period).
- It does **not** turn on for daily budget misses.
- It means PELS has already used every managed device it can limit.

Pair it with the **Hard cap breach imminent — manual action needed** trigger for urgent notifications.

## What the device does not replace

The Insights device is a status surface, not a configuration tool.

- Use the **Overview** tab to inspect the detailed plan.
- Use **Settings > Limits & safety** for capacity tuning and **Budget** for daily-budget tuning.
- Use **Flow Cards** when you need automations around state changes.
