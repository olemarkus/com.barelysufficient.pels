---
title: Deadline Charging With State of Charge
description: Charge an EV to a battery target by a ready-by time using PELS Smart tasks, state of charge, Homey Flows, and dashboard widgets.
---

# Deadline Charging With State of Charge

Use this setup when the real question is:

> "Will the car be at 80% by 07:00?"

That is different from "run the charger for five cheap hours." Deadline charging starts with the outcome you care about: a target battery level and a ready-by time. PELS then chooses useful charging hours before that time, checks prices, protects the hard cap, and keeps watching the car's state of charge.

State of charge, or SoC, is the battery percentage Homey receives from the car or charger. With SoC, PELS can see whether charging is actually moving toward the target. Without it, any schedule is still a guess.

## Why This Is the Gold Standard

SoC-based deadline charging is the best EV charging pattern in PELS because it closes the loop.

| Older pattern | Deadline charging with SoC |
| --- | --- |
| Pick a number of cheap hours. | Pick the battery target and ready-by time. |
| Hope the chosen hours are enough. | PELS tracks progress against the target. |
| Manually adjust after cold weather, slow charging, or a half-full battery. | PELS learns the charger and replans when the estimate changes. |
| Cheap hours are the goal. | Readiness is the goal; cheap hours are used when they still fit. |
| Hard-cap handling is separate from the schedule. | The same plan still respects the hard cap and priorities. |

The result is calmer:

- If you only want confirmation, the **Smart tasks** widget tells you whether the car is on track.
- If this is your first charging setup, the **New smart task** widget lets you create the task without learning modes.
- If you optimize every run, the plan view shows which hours were selected and why.
- If a previous run missed, the next run gives you an early **At risk** or **Cannot finish** signal.
- If a notification sends you here, the active EV smart task is the one thing to check first.

## What You Will Build

You will set up:

1. EV charger current control, so PELS can pause, resume, or lower charging through Homey.
2. Battery percentage reporting, so PELS knows the car's state of charge.
3. A Homey dashboard with PELS widgets for creating and watching the task.
4. A first charging task: for example, charge the EV to `80%` by `07:00`.
5. Optional automation that creates the same task every time the car is plugged in.

You do not need to configure PELS modes for this guide.

## Before You Begin

You need:

- PELS installed and receiving live whole-home power data.
- Price-aware planning enabled, with prices available through the ready-by time.
- An EV charger paired in Homey.
- A Homey charger app or Flow action that can set available current or available power for the charger.
- A car or charger app that can expose battery percentage in Homey, or a Flow that can send that percentage to PELS.

If PELS is not installed yet, start with [Getting Started](/getting-started). If your power or price source comes from Homey Energy, see [Using Homey Energy](/homey-energy). A charging task can stay at **Building plan…** until prices are available for the whole ready-by window.

Homey background reading:

- [Homey Energy](https://homey.app/en-us/features/energy/) shows EV and battery state in the Energy experience.
- [Understanding the Homey Energy tab](https://support.homey.app/hc/en-us/articles/19383696079132-Understanding-the-Homey-Energy-tab) explains the EV Charger and Electric Vehicle tiles.
- Homey's app documentation describes EV battery state of charge through the `measure_battery` capability in [Energy](https://apps.developer.homey.app/the-basics/devices/energy) and [Battery status](https://apps.developer.homey.app/the-basics/devices/best-practices/battery-status).

## Step 1: Connect The Charger To PELS

First make PELS able to control charging current.

1. Open **Apps -> PELS -> Settings -> Devices**.
2. Open the EV charger.
3. Enable **Managed by PELS**.
4. Choose **EV 1-phase** or **EV 3-phase**, matching your charger setup.
5. Create the current-control Flow described in [Configure an EV Charger](/ev-charger).

For a Zaptec charger, use the shorter [Zaptec EV Charger](/zaptec-ev-charger) guide.

### Choose The Default Charging Behavior

For deadline charging, many homes use this default:

- **Managed by PELS**: on.
- **Power-limit control**: off by default.
- A Smart task makes the charger available during planned charging hours.

That prevents the charger from starting in an expensive hour just because the home has available power. During the planned task hours, PELS can still make room for the charger while staying under the hard cap.

If you also want normal "charge when there is room" behavior outside Smart tasks, leave **Power-limit control** on. That is simpler, but the charger may run outside the selected deadline plan.

## Step 2: Give PELS The Battery Percentage

PELS needs battery percentage for the charger it is planning. There are two common paths.

### Path A: The Charger Reports Battery Percentage

Some charger integrations expose battery level on the charger device itself. If Homey exposes that as a supported battery percentage capability, PELS can read it directly.

Check the charger in **Apps -> PELS -> Settings -> Devices**. The device detail should show battery level once PELS has seen a reading.

### Path B: The Car Reports Battery Percentage

Often the battery percentage lives on the car device, not the charger. In that case, create Flows that report the car value to the PELS charger entry:

| Flow part | Card |
| --- | --- |
| **When** | Your car app: battery level changed |
| **Then** | PELS: **Report battery level for charger** |

In the PELS action card:

- Select the same charger you use for current control.
- Put the car app's battery percentage tag into **Battery level (%)**.

Also report the current battery level when the car is plugged in. If your car app does not emit a new battery event until charging starts, add a periodic Flow while the car is plugged in, for example every 30 minutes. PELS needs a fresh SoC reading even when the percentage has not changed yet.

This links the car's SoC to the charger PELS controls. It is also the path to use when Homey shows battery percentage for the car, but not for the charger.

## Step 3: Add The Dashboard Widgets

Homey dashboards let you use PELS without opening the PELS settings page for every task. Homey's dashboard guide is here: [Create and manage Homey Dashboards](https://support.homey.app/hc/en-us/articles/16732145289116-Create-and-manage-Homey-Dashboards).

Create an EV charging dashboard and add these PELS widgets:

| Widget | Use it for |
| --- | --- |
| **New smart task** | Create the charging task from the dashboard. |
| **Smart tasks** | Watch whether the EV task is **Scheduled**, **On track**, **At risk**, or **Cannot finish**. |
| **Available power** | See whether the home is close to the hard cap right now. |
| **Budget and Price** | See today's budget, price shape, and whether the day is tracking to plan. |
| **Held-back devices** | Optional: see devices currently waiting and release an eligible one when you deliberately want it sooner. |

Put **New smart task** near **Smart tasks**. The first creates the task; the second tells you whether it is still healthy.

## Step 4: Create The Charging Task

From the **New smart task** widget:

1. Pick the EV charger.
2. Set the target, for example `80%`.
3. Set **Ready by**, for example `07:00`.
4. Preview the plan.
5. Confirm the task.

Leave **Extra permissions** off for the first run. A normal EV deadline should prove itself inside the daily budget and hard cap before you give it more leeway.

After confirmation, the **Smart tasks** widget and the PELS **Smart tasks** page show the active charging task.

## Step 5: Read The Result

Use the widgets in this order.

| What you see | What it means |
| --- | --- |
| **Scheduled** | PELS has selected future charging hours. No action is needed. |
| **On track** | The task is progressing and PELS expects it to reach the target. The task detail may also say **Charging now** during an active charging hour. |
| **Paused — unplugged** | The EV task is paused because the car is unplugged or the session ended. Plug the car back in if the deadline still matters. |
| **At risk** | The target may still be possible, but time or available power is getting tight. |
| **Cannot finish** | PELS does not currently see enough usable charging before the ready-by time. |

Open the task in the PELS **Smart tasks** page when you want more detail. The plan view shows selected hours, price context, expected charging work, background usage, and target progress.

The important distinction: cheap hours are preferred, but readiness wins. If the car needs energy soon, PELS may choose a normal or expensive hour rather than miss the deadline.

## Step 6: Make It Automatic After The First Good Run

The widget is the easiest way to create a one-off task. Once the first run behaves correctly, you can automate task creation with a simple Homey Flow. Homey's Flow basics are here: [Create your first Flow](https://support.homey.app/hc/en-us/articles/360009669174-Create-your-first-Flow).

Typical repeating Flow:

| Flow part | Card |
| --- | --- |
| **When** | Your car or charger app: car plugged in |
| **Then** | PELS: **Add charging task** |

Use the same target and ready-by time you tested in the widget, for example `80%` by `07:00`.

Keep the battery-reporting Flow from Step 2 running. The charging task is only as good as the battery percentage PELS receives.

## When To Use Flow-Booked Cheap Hours Instead

Use [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows) instead when:

- You do not have a battery percentage source.
- You only care about a fixed number of cheap hours.
- You want the schedule to live entirely in Homey Flow logic.

Use deadline charging when the car's final battery level matters.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The charger is not offered in **New smart task** | Confirm it is paired in Homey, visible in PELS, **Managed by PELS**, and configured as **EV 1-phase** or **EV 3-phase**. |
| Battery percentage does not appear | Check whether the value is on the charger or on a separate car device. If it is on the car device, use **Report battery level for charger**. |
| The task stays at **Building plan…** | Check that price data is available through the ready-by time. Tomorrow's prices may not be published yet. |
| The charger starts outside the task hours | Turn **Power-limit control** off by default if charging should only happen during Smart task hours. |
| The task is **At risk** | Check that the car is plugged in, the charger current is correct, the hard cap leaves enough room, and the target is realistic for the time left. |
| The task is **Cannot finish** | Lower the target, move the ready-by time later, plug in earlier, reduce competing load, or review the charger setup. Raising the hard cap is only correct if your physical limit or tariff step is actually higher. |
| Charging current does not change | Recheck the current-control Flow from [Configure an EV Charger](/ev-charger). For charger current fields, use **EV charger current (A)**. |

## Related Pages

- [Smart Tasks](/smart-tasks)
- [Configure an EV Charger](/ev-charger)
- [Zaptec EV Charger](/zaptec-ev-charger)
- [Dashboard Widgets](/widgets)
- [EV charging under a power limit](/use-cases/homey-ev-charging-power-limit)
- [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows)
