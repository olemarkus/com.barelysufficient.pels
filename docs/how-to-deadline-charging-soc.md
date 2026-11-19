---
title: Deadline Charging With State of Charge
description: Charge an EV to a battery target by a ready-by time using a Smart task in PELS Settings. Repeat it on a schedule or when the car plugs in.
---

# Deadline Charging With State of Charge

Use this setup when the real question is:

> "Will the car be at 80% by 07:00?"

That is different from "run the charger for five cheap hours." Deadline charging starts with the outcome you care about: a target battery level and a ready-by time. PELS then chooses charging periods before that time, checks prices, respects the enabled house power limits, and keeps watching the car's state of charge. Periods follow the price source: hourly or 15-minute prices.

State of charge, or SoC, is the battery percentage Homey receives from the car or charger. With SoC, PELS can see whether charging is actually moving toward the target. Without it, PELS can instead track an energy task in kWh from live charger power readings; that task does not promise a final battery percentage.

## Why This Is the Gold Standard

SoC-based deadline charging is the best EV charging pattern in PELS because it closes the loop.

| Older pattern | Deadline charging with SoC |
| --- | --- |
| Pick a number of cheap hours. | Pick the battery target and ready-by time. |
| Hope the chosen hours are enough. | PELS tracks progress against the target. |
| Manually adjust after cold weather, slow charging, or a half-full battery. | PELS learns the charger and replans when the estimate changes. |
| Cheap hours are the goal. | Readiness is the goal; cheaper periods are used when they still fit. |
| Hard-cap handling is separate from the schedule. | The same plan still respects enabled house power limits and priorities. |

Open **Smart tasks** in PELS to create a task, check its progress or see why the plan changed. If you use a Homey dashboard, the **Smart task list** widget also shows whether the car is on track.

## What You Will Build

1. Connect the charger so PELS can control charging through Homey.
2. Give PELS the car's battery level.
3. Create a first charging task in PELS, for example `80%` by `07:00`.
4. Optionally repeat it on a schedule or whenever the car plugs in.

You do not need to configure PELS modes for this guide.

## Before You Begin

You need:

- PELS installed and receiving live whole-home power data.
- **Respond to prices** turned on under **Price-aware devices**, with prices available through the ready-by time.
- An EV charger paired in Homey.
- A way for PELS to start and pause charging. For an adjustable charger, check [how PELS sets charging current or power](/ev-charger#charging-current-setup).
- A car or charger app that can expose battery percentage in Homey, or a Flow that can send that percentage to PELS.

If PELS is not installed yet, start with [Getting Started](/getting-started). If your power or price source comes from Homey Energy, see [Using Homey Energy](/homey-energy). A charging task shows **Waiting for a plan** while it waits for its planning turn or for prices through the ready-by time. The reason line says which.

Homey background reading:

- [Homey Energy](https://homey.app/en-us/features/energy/) shows EV and battery state in the Energy experience.
- [Understanding the Homey Energy tab](https://support.homey.app/hc/en-us/articles/19383696079132-Understanding-the-Homey-Energy-tab) explains the EV Charger and Electric Vehicle tiles.
- Homey's app documentation describes EV battery state of charge through the `measure_battery` capability in [Energy](https://apps.developer.homey.app/the-basics/devices/energy) and [Battery status](https://apps.developer.homey.app/the-basics/devices/best-practices/battery-status).

## Step 1: Connect The Charger To PELS

First give PELS control of charging.

1. Open **More -> Apps -> PELS -> Settings -> Devices**.
2. Open the EV charger.
3. Enable **Managed by PELS**.
4. For adjustable charging current, use **Automatic** where offered. If setting the model manually, use **EV 1-phase** for 230 V single-phase charging or **EV 3-phase** for 400 V TN three-phase charging.
5. Check [how PELS controls your charger](/ev-charger#charging-current-setup). For a start/stop charger, PELS switches charging on or off during the task.

### Choose The Default Charging Behavior

Keep **Managed by PELS** on. Choose how the charger should behave between tasks:

- To charge whenever there is room, leave **Power-limit control** on.
- To leave plug-in starts to the charger, turn **Power-limit control** off.
- To keep the charger off between tasks, turn **Power-limit control** off and create your first task. Once the charger has had a task, its **Power limiting** section offers **Only PELS starts this device**. Turn that on.

During a task, PELS holds charging off in deferred periods. A period the task keeps without planned energy can still be used if power becomes available.

## Step 2: Give PELS The Battery Percentage

PELS needs battery percentage for the charger it is planning. Choose one of the following paths.

### Path A: Select A Supported Car

Open the charger's **Car** section in **More -> Apps -> PELS -> Settings -> Devices** and select the cars that charge there. PELS reads the battery level from the car it matches to the charger. If the car is not listed, use its battery-percentage tag through Path C instead.

Selecting a car does not itself establish a match. While the page says **Waiting to identify the connected car**, this charger has no battery level. While any car is selected, PELS ignores the **Report battery level for charger** Flow card, including before a match. Clear the selection if you want to use the Flow instead.

PELS matches cars to chargers whether or not they are selected; when a car selected for another charger plugs in there, it is matched there, not here. Under each car, the **Car** section shows `Matched to this charger now` for the car on it now, `Last matched to this charger on <date>`, `Not matched to this charger` when the car has matched a different charger that is still in Homey, or `Not matched to this charger yet`. If you already report the battery level through a Flow, wait until the car shows as matched before you select it.

### Path B: The Charger Device Shows Battery Percentage

An ordinary charger does not know the car's battery level. This path applies when the device PELS controls is the car itself, such as a Tesla controlled as a charger, or when the charger's Homey app fetches the level from the car maker. Leave the charger's car selection empty and PELS reads that battery percentage directly.

Check the charger in **More -> Apps -> PELS -> Settings -> Devices**. The device detail should show battery level once PELS has seen a reading.

### Path C: Report Battery Percentage Through A Flow

With no car selected in the charger's **Car** section, you can use Flows to report the car's battery percentage to the PELS charger entry:

| Flow part | Card |
| --- | --- |
| **When** | Your car app: battery level changed |
| **Then** | PELS: **Report battery level for charger** |

In the PELS action card:

- Select the same charger you use for current control.
- Put the car app's battery percentage tag into **Battery level (%)**.

Also report the current battery level when the car is plugged in. If your car app does not emit a new battery event until charging starts, add a periodic Flow while the car is plugged in, for example every 30 minutes. PELS needs a fresh SoC reading even when the percentage has not changed yet.

This reports the battery level to the charger PELS controls; it does not create an automatic car association. Use this path when you prefer Flow reporting or the car is not supported by the car picker. Do not configure it as a fallback for a selected car: PELS ignores it while any car is selected.

## Step 3: Create The Charging Task {#step-4-create-the-charging-task}

1. In PELS, open **Smart tasks** and choose **New smart task**.
2. Pick the EV charger and set the target battery level, for example `80%`.
3. Set the ready-by time, for example `07:00`, and check the displayed day.
4. Choose **Preview task**, review the plan and estimated cost, then choose **Create task**.

Leave **Extra permissions** off for the first run to see how the task fits within the daily budget and enabled house power limits. You can review its power guarantee on the task page later.

After confirmation, open the task on the **Smart tasks** page to follow its progress.

## Step 4: Read The Result {#step-5-read-the-result}

Check the task status on the **Smart tasks** page or in the **Smart task list** widget.

| What you see | What it means |
| --- | --- |
| **On track** | PELS expects the task to reach the target — either charging periods are selected for later, or charging is already progressing. The task detail may also say **Charging now** during an active charging period. |
| **Paused — unplugged** | The EV task is paused because the car is unplugged or the session ended. Plug the car back in if the deadline still matters. |
| **At risk** | The target may still be possible, but time or available power is getting tight. |
| **Cannot finish** | PELS does not currently see enough usable charging before the ready-by time. |

Open the task in the PELS **Smart tasks** page when you want more detail. The plan view shows selected periods, prices, target progress and **About this estimate**. That card explains the planned power guarantee and the energy estimate. **Review power guarantee** previews changes to the task's permissions; **Change target or deadline** changes its goal or ready-by time.

Cheaper periods are preferred, but readiness wins. If the car needs energy soon, PELS may choose a normal or expensive period to reach the target on time.

## Optional: Add Dashboard Widgets {#step-3-add-the-dashboard-widgets}

If you use a Homey dashboard, add **Create smart task** to start a task there and **Smart task list** to see its progress. See [Dashboard Widgets](/widgets) for the dashboard setup.

## Step 5: Repeat The Task {#step-6-make-it-automatic-after-the-first-good-run}

For a fixed routine, open **Settings → Schedules → New schedule**, choose **Smart task**, and set the creation time, repeat days, charger, target and ready-by time.

For an event such as plugging in the car, automate task creation with a Homey Flow. Homey's Flow basics are here: [Create your first Flow](https://support.homey.app/hc/en-us/articles/360009669174-Create-your-first-Flow).

Typical repeating Flow:

| Flow part | Card |
| --- | --- |
| **When** | Your car or charger app: car plugged in |
| **Then** | PELS: **Add charging task** |

Use the same target and ready-by time you tested with the first task, for example `80%` by `07:00`.

Keep the battery source you set up in Step 2 working: the selected car, the battery percentage on the charger device, or the battery-reporting Flow. The charging task is only as good as the battery percentage PELS receives.

## Charging Without Battery Percentage

A plugged-in charger with live power readings and no battery percentage is offered an energy task in **New smart task** and the **Create smart task** widget. Choose an amount such as `20 kWh` by `07:00`. PELS tracks electricity delivered through the charger, including charging losses. Use the **Add energy task** Flow card if you want to request a kWh target even when battery percentage is available. See [Energy tasks](/smart-tasks#energy-tasks).

Use battery-target charging when the car's final battery level matters.

## When To Use Flow-Booked Cheap Hours Instead

Use [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows) instead when:

- You only care about a fixed number of cheap hours.
- You want the schedule to live entirely in Homey Flow logic.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The charger is not offered in **New smart task** | Open **Devices** and confirm PELS recognizes the paired device as an EV charger and **Managed by PELS** is on. |
| Battery percentage does not appear | Check whether the value is on the charger or on a separate car device. If it is on the car device, select the car in the charger's **Car** section (Path A) and wait for PELS to match it. If the car is not listed there, report its battery percentage with **Report battery level for charger** (Path C). |
| The task stays at **Waiting for a plan** | Check the reason line. If it is waiting for prices, check that price data reaches the ready-by time. Tomorrow's prices may not be published yet. |
| The charger starts in a period outside the plotted task plan | The task keeps that period without planned energy, because it is cheaper than the planned periods or the task cannot finish otherwise, and charges there when power is available. A deferred period is held off. For charging only during tasks, turn **Power-limit control** off and enable **Only PELS starts this device**. |
| The task is **At risk** | Check that the car is plugged in, the charger current is correct, and the target is realistic for the time left. If other devices take the room, open **Review power guarantee** to preview what the task needs and the effect of extra permissions. If the reason names the car's own schedule or smart charging, turn that off in the car. |
| The car's own charge limit is below the target | The task keeps your target. As soon as PELS knows the car's limit is lower, the task shows **At risk** (or **Cannot finish**) with the limit as the reason, and it ends as missed if the car stops there. Raise the charge limit in the car, or lower the task's target to the car's limit. While the car is still below its limit, the daily budget is named instead when it is what holds the task back. A car unplugged before it reaches the limit shows **Paused — unplugged**; plug it in. |
| The task is **Cannot finish** | Lower the target, move the ready-by time later, plug in earlier, reduce competing load, or review the charger setup. Keep the configured house power limits matched to your home. |
| Charging current does not change | Check [how PELS controls your charger](/ev-charger#charging-current-setup). If you use a current-control Flow, check its **EV charger current (A)** tag. |

For problems beyond charging — budget, capacity, or a missed task — see the full [Troubleshooting guide](/troubleshooting).

## Related Pages

- [Smart Tasks](/smart-tasks)
- [Configure an EV Charger](/ev-charger)
- [Zaptec EV Charger](/zaptec-ev-charger)
- [Dashboard Widgets](/widgets)
- [EV charging under a power limit](/use-cases/homey-ev-charging-power-limit)
- [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows)
