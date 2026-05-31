---
title: Smart Tasks
description: Use PELS Smart tasks to charge, heat, or prepare a managed device by a specific time using the best available hours.
---

# Smart Tasks

Smart tasks tell PELS that one device should reach a target by a ready-by time.

PELS picks the best hours before the ready-by time — the cheapest hours when prices are available — and lines them up against the device priority, daily budget, power-limit control, and hard cap settings already configured. The task lands on time, on the right hours, without anyone watching prices.

## What Smart Tasks Are For

Use a Smart task when the timing matters for one device:

- Charge an EV to a target battery percentage by 07:00.
- Heat a room to a target temperature before people wake up.
- Heat a water heater before a period when hot water matters.

If you only want the whole home to spend more energy during cheap hours, use [Daily Energy Budget](/daily-budget) instead. If you want a fixed number of cheap hours without a target, use [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows).

## How a Task Is Created

Smart tasks are created from Homey Flow action cards:

| Action card | Use for |
| --- | --- |
| **Add charging task** | EV chargers with a battery target and ready-by time |
| **Add heating task** | Temperature devices with a target temperature and ready-by time |
| **Clear smart task** | Removes the active task for the selected device |

The ready-by value is written as local time, for example `07:00`. PELS stores the next matching future time when the Flow runs. It does not automatically repeat the same task every day unless your Flow runs again.

You can also create a Smart task without a Flow from the **New smart task** dashboard widget: pick a device, set the goal and a **Ready by** time, preview the plan, and confirm. See [Dashboard Widgets](/widgets) for the full widget set.

## What PELS Plans

For each active task, PELS evaluates:

- the target
- the current observed progress, when available
- the ready-by time
- hourly prices through the ready-by time
- the device's expected or learned energy delivery
- the daily budget and hard cap
- the device priority and normal admission rules

The Smart task plan chooses hours before the ready-by time. If prices are available for the whole window, cheaper hours are preferred. If tomorrow's prices are needed but not available yet, the task can remain pending until the price window is complete.

![Smart task plan showing selected hours before a ready-by time](screenshots/deadline-plan/480.png)
*Figure 1. A Smart task plan shows the selected price horizon, expected device work, background usage, and target progress.*

## Why the Plan Changed

PELS shows what triggered each replan:

- On the **active task** page, the **Recent plan changes** panel lists the reasons in order, most recent first — for example *Tomorrow’s prices published*, *Rate estimate refined*, or *Schedule revised — daily budget shifted*.
- On a **past task**, the **What changed** card on the history-detail page tells the same story for the finished run.

The panel collapses itself when every revision came from a Flow card (the user already knows what they did).

## Power-Limit Control and Tasks

Power-limit control changes what happens outside the task's planned hours.

| Device setup | Outside planned task hours | During planned task hours |
| --- | --- | --- |
| **Power-limit control on** | The device can still run as part of normal PELS behavior when there is available power | PELS gives the task a planned opportunity to run, still under the hard cap |
| **Power-limit control off** | PELS keeps the device idle for the task unless another automation controls it | PELS makes the device available for the planned task hours |

For EV charging, a common setup is to keep the charger managed by PELS but turn power-limit control off until a charging task or Flow-booked hour allows it to run. That prevents the charger from starting just because the home has available power in an expensive hour.

## Budget and Task Interaction

Smart tasks compose with the rest of PELS — every layer keeps working underneath the task:

- The **hard cap** stays the hourly boundary PELS protects.
- **Daily budget** holds the task to a sensible pace when the day is already running hot.
- **Priority** decides which devices get room first when something has to wait.
- **Price-based temperature shift** keeps adjusting normal targets; a heating task target becomes the readiness target for that task.

## Letting a Task Push Harder

By default a Smart task stays polite: it keeps to the daily budget and never takes power from devices you have ranked higher or equal. If a task is **At risk** of missing its target and the deadline matters, you can grant it extra leeway with the **Set what a smart task may do** action card.

| Permission | What it allows |
| --- | --- |
| **go over today's budget** | The device may keep running during its planned hours even when the daily budget would normally pace it down. The daily budget is a soft, price-shaped target, so this lets the task run past it. |
| **limit lower-priority devices** | The task may have lower-priority devices limited — paused or turned down — so it gets the power it needs. Devices at the same or higher priority are never touched. |

For each permission you choose when it applies:

| When | Effect |
| --- | --- |
| **At no time** | The permission is off. |
| **While it's scheduled to run** | The permission applies during the task's planned hours, and stays set until you change it or clear the task. |

Two things stay true no matter what you grant:

- Both permissions stay inside the **hard cap**. PELS never exceeds your physical capacity limit to rescue a task. If a task still cannot finish within the hard cap, the fix is a lower daily budget or fewer competing devices — not a higher cap.
- Permissions persist once you grant them, but they have no effect until the planned hours or the rescue gate apply — so a task already on track stays on its normal plan.

### Example: a water heater that must be ready

A water heater is set to reach 65 °C by 07:00 with cheap overnight hours booked. Someone showers at 21:00 and the tank drops well below target, leaving the morning short. To keep mornings covered, grant the task either permission:

- **go over today's budget** so the heater can reheat during its planned hours even if the day's budget is tight.
- **limit lower-priority devices** so it can claim power from loads you care about less.

You can grant the leeway as a standing setting once the task exists, or only when time is short. Pair **Smart task time is running low** (for example, 2 hours left) with **Smart task status is At risk** so a Flow grants the permission late — only when a task actually needs the help.

## Different Targets Can Be Useful

A mode target, a boost setting, and a Smart task target do not have to be the same value. They describe different intent:

| Setting | What it means |
| --- | --- |
| **Mode target** | The normal target for the active mode, such as Home, Night, or Away. |
| **Boost setting** | A temporary extra push, such as cheap-hour temperature boost or charge boost when a battery is low. |
| **Smart task target** | A one-off readiness goal by a specific time. |

That separation is often useful. For example, a room can normally sit at 18 °C in Night mode, use cheap-hour boost when prices are low, and still have a task to reach 21 °C by 06:30. An EV charger can have a low charge-boost threshold for basic readiness while a charging task aims for a higher target before a trip.

For many homes, this is the useful combination:

1. Power limiting protects the hard cap.
2. Daily budget shifts whole-home usage toward cheaper hours.
3. Smart tasks reserve attention for specific devices that must be ready.

## Status and History

The Smart tasks view shows current tasks and past tasks. Flow cards can also react to status changes.

| Status | Meaning |
| --- | --- |
| **Building plan…** | A task is stored but PELS has not allocated hours yet — usually because prices through the ready-by time are not available. |
| **Scheduled** | A plan is ready and the first scheduled hour is still in the future. |
| **Paused — unplugged** | EV only: the charging task is paused because the car is unplugged or the session ended. The plan resumes when the car is plugged back in. |
| **On track** | PELS currently expects the task to reach the target. |
| **At risk** | PELS has a plan, but there is limited time or room left. |
| **Cannot finish** | PELS does not currently see enough usable time or energy delivery before the ready-by time. |
| **Satisfied** | The observed target is already met. If a later reading drops below the target before the ready-by time, PELS returns to tracking it. |

If no active task is stored for a device, that device simply has no Smart task status.

Use **Smart task status changed** for live notifications as a task is being tracked. Use **Smart task ended** when you want an alert after the task run concludes.

### Outcomes

The **Smart task ended** trigger fires once when a task run concludes, with an **Outcome** tag:

| Outcome | What it means |
| --- | --- |
| **succeeded** | The task reached its target by the ready-by time. |
| **missed** | PELS ran the planned hours but did not reach the target by the ready-by time. |
| **abandoned** | The task was finalized before it could complete — either because **Clear smart task** ran (manually or from another Flow), or because the device stopped reporting for about an hour while the deadline was still in the future. |

Filter on the tag when only some outcomes should notify, for example `Outcome = missed` for a "did not reach target" alert. An **abandoned** outcome is usually not a planning failure — it means the situation changed before the task could complete.

Two things that look like an abandonment but aren't:

- A *briefly* unplugged EV shows the **Paused — unplugged** status and resumes when plugged back in. Only an unplug that lasts past the abandon grace window finalizes the task as **abandoned**.
- A new smart task that replaces an in-progress one produces an internal `replaced` outcome. The **Smart task ended** trigger is intentionally suppressed in that case so the new task isn't shadowed by an ended-trigger for the old one.

## If a Task Missed

When the **History** view shows a missed entry, PELS surfaces one of two recourse buttons. The split tells you what to investigate.

| Recourse button | What happened | What to do |
| --- | --- | --- |
| **Lower daily budget** | The daily energy budget ran out before the ready-by time. PELS had hours scheduled but the budget cap closed those hours down. | Lower the daily budget so future days reserve usable power earlier — in the **Budget** tab or via the **Set daily budget** Flow card. Raising the **hard cap** is not the right answer: the hard cap reflects your physical breaker or grid tariff step, not a tuning knob. |
| **Review device** | The task ran its planned hours but the device couldn't deliver enough, capacity pressure shortened the available hours, or a replan (e.g. new prices arriving, schedule revised) reduced the planned window. | The button deep-links you to the device-settings overlay. Check stepped-load planning power, target temperature, priority, **When limiting** behavior, and the Flow wiring that reports state back to PELS. |

If the same device misses repeatedly, treat it as a tuning loop:

1. Read the cause sentence on the history-detail card.
2. Apply the recommended recourse.
3. Compare the next run.

If the task needs more room only on the run before the deadline, **Set what a smart task may do** can grant *go over today's budget* or *limit lower-priority devices* permission for the scheduled hours — see [Letting a Task Push Harder](#letting-a-task-push-harder).

For **abandoned** runs, the usual answer is that there is nothing to fix. Only investigate if the abandonment was unexpected — for example, a Flow you didn't expect ran **Clear smart task**, or an EV unplug event fired when the car was still connected.

## Practical Examples

### Charge an EV by morning

Create a Flow that runs when the car is plugged in:

| Flow part | Card |
| --- | --- |
| **When** | Charger or car app: plugged in |
| **Then** | PELS: **Add charging task** |

Set the target battery percentage and ready-by time, for example `80 %` by `07:00`.

Recommended charger setup:

- **Managed by PELS** on
- **Power-limit control** off by default if charging should only happen during planned task hours
- EV current-control Flow wired as described in [Configure an EV Charger](/ev-charger)
- Battery reporting Flow configured when your car or charger app can provide it

### Heat before a known time

Create a scheduled Flow:

| Flow part | Card |
| --- | --- |
| **When** | Time is 20:00 |
| **Then** | PELS: **Add heating task** |

Set the target temperature and ready-by time, for example `21 °C` by `06:30`.

This is useful for rooms or water heaters where the exact ready time matters more than simply reacting to the current price level.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The task stays pending | Check that price optimization is enabled and that prices are available through the ready-by time. |
| The EV task does not change charger current | Confirm the charger is configured as EV 1-phase or EV 3-phase and the Flow uses **EV charger current (A)**. |
| The task starts too early | Check whether **Power-limit control** is on; with it on, normal PELS behavior can still run the device outside planned task hours. |
| The task cannot meet the target | Check target size, ready-by time, planning power/current, daily budget, and device priority. |
| A completed task starts tracking again | This is expected if a fresh reading drops below the target before the ready-by time. |
