---
title: PELS Insights Device
description: Add the PELS Insights virtual device to Homey dashboards and see mode, headroom, and limit status at a glance.
---

# PELS Insights Device

PELS includes a virtual device called **PELS Insights**. It is the easiest way to surface planner status in dashboards, favorites, and quick checks inside Homey.

## Add the device

1. Open **Devices -> Add Device**
2. Select **PELS**
3. Choose **PELS Insights**
4. Add the device

## What it shows

The current driver exposes these core capabilities:

| Capability | Meaning |
| --- | --- |
| **Operating mode** | Current PELS mode selected in settings or by Flow |
| **Capacity shortfall** | Whether PELS projects an hourly hard-cap breach and cannot shed any more load |
| **Headroom** | Available power before the current soft limit |
| **Current soft limit** | Effective soft limit currently used for shedding |
| **Used this hour** | Energy consumed so far in the current hour |
| **Daily budget remaining** | Remaining daily budget, when daily pacing is enabled |
| **Daily budget exceeded** | Whether the daily plan is currently over target |
| **Limit reason** | Why restores are currently constrained or why shedding is active |
| **Controlled load** | Current controlled load |
| **Uncontrolled load** | Current uncontrolled load |
| **Price level** | Current price bucket relative to the day average |
| **Devices active** | Number of controlled devices not currently shed |
| **Devices shed** | Number of controlled devices currently shed |

## When it is most useful

- Pin it to Homey favorites if you want a quick read on whether the system is under pressure.
- Use it as a visual companion to the **Capacity guard: manual action needed** trigger.
- Check **Limit reason** and **Headroom** before assuming something is wrong with a device.

## What shortfall means

The **Capacity shortfall** alarm is intentionally strict.

- It only applies to projected **hourly hard-cap** breaches.
- It does **not** fire for daily budget misses.
- It means PELS has already exhausted the available controllable shedding options.

That makes it appropriate for urgent notifications and manual intervention.

## What the device does not replace

The Insights device is a status surface, not a full configuration tool.

- Use the **Overview** tab to inspect the detailed plan.
- Use the **Budget** tab for capacity and daily-budget tuning.
- Use **Flow Cards** when you need automations around state changes.
