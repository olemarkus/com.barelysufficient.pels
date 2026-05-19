---
title: PELS Insights Device
description: Add the PELS Insights virtual device to Homey dashboards and see mode, available power, and limit status at a glance.
---

# PELS Insights Device

PELS includes a virtual device called **PELS Insights**. It is the easiest way to surface planner status in dashboards, favorites, and quick checks inside Homey.

## Add the device

1. Open **Devices -> Add Device**
2. Select **PELS**
3. Choose **PELS Insights**
4. Add the device

## What it shows

The Insights device exposes these readings. The labels below match the capability titles shown in Homey.

| Reading | Meaning |
| --- | --- |
| **Operating mode** | Current PELS mode selected in settings or by Flow |
| **Manual action needed** | Whether PELS projects an hourly hard-cap breach and cannot limit any more load |
| **Available power** | Extra power PELS can fit before the current safe pace |
| **Current safe pace** | Current effective pace used for power limiting |
| **Used this hour** | Energy consumed so far in the current hour |
| **Daily budget remaining** | Remaining daily budget, when daily pacing is enabled |
| **Daily budget exceeded** | Whether the daily plan is currently over target |
| **Limit reason** | Why devices are currently constrained or why limiting is active |
| **Managed device usage** | Power currently being drawn by managed devices |
| **Background usage** | Power currently being drawn outside managed devices |
| **Price level** | Current price bucket relative to the day average |
| **Devices active** | Number of managed devices not currently limited |
| **Devices limited** | Number of managed devices currently limited |

## When it is most useful

- Pin it to Homey favorites if you want a quick read on whether the system is under pressure.
- Use it as a visual companion to the **Capacity guard: manual action needed** trigger.
- Check **Limit reason** and **Available power** before assuming something is wrong with a device.

## What the capacity guard means

The capacity guard alarm is intentionally strict.

- It only applies to projected **hourly hard-cap** breaches.
- It does **not** fire for daily budget misses.
- It means PELS has already exhausted the available managed-device limiting options.

That makes it appropriate for urgent notifications and manual intervention.

## What the device does not replace

The Insights device is a status surface, not a full configuration tool.

- Use the **Overview** tab to inspect the detailed plan.
- Use **Settings > Limits & safety** for capacity tuning and **Budget** for daily-budget tuning.
- Use **Flow Cards** when you need automations around state changes.
