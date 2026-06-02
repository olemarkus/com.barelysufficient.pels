---
title: Dashboard Widgets
description: Pin PELS widgets to a Homey dashboard to watch available power, today's budget, and Smart task progress — and to start or release a device — without opening the app.
---

# Dashboard Widgets

PELS ships five small widgets you can pin to a Homey dashboard. Most show status at a glance and refresh on their own; two are interactive — **New smart task** lets you create a task and **Held-back devices** lets you release one — straight from the dashboard.

Add any widget from your Homey dashboard's widget picker, then place it where you want.

## Available power

Answers **"how much room do I have right now?"**

![Available power widget showing current draw against the hour budget, a price-low chip, and two devices held back](/screenshots/widgets/available-power.png)

The widget shows:

- Current draw against the current effective hour budget, with a coloured bar that turns warning at 85 % and danger at 100 %.
- Available power remaining in the current hour.
- The number of devices PELS is holding back, when any are.
- A price-level chip when prices are cheap or expensive (hidden when prices are normal).

It refreshes about every 10 seconds and keeps showing the last known reading (dimmed) if Homey briefly misses a measurement, so the widget never blanks during a transient hiccup.

## Budget and Price

Answers **"where will today land?"**

![Budget and Price widget showing the hourly plan chart with managed usage bars, a price curve, a now-line, and a projected end-of-day total](/screenshots/widgets/budget-and-price.png)

The widget shows today's hourly plan as a chart — managed and background usage against the daily budget — with the cheaper and more expensive hours marked, a now-line, and a projected end-of-day total in kWh and money. Use it to see at a glance whether the day is tracking to plan and which hours are the cheap ones.

## Smart tasks

Answers **"are my deadlines on track?"**

![Smart tasks widget listing three tasks ranked by attention needed, each with a status chip and ready-by time](/screenshots/widgets/smart-tasks.png)

The widget lists up to three active Smart tasks, ranked by how much attention they need: tasks PELS expects to miss first, then at-risk, then pending, then on-track. Satisfied tasks drop off automatically.

Each row shows:

- Device name and the status chip (for example **Cannot finish**, **At risk**, **Scheduled**, **On track**, or **Unplugged**).
- The current value moving toward the target (for example `19 °C → 21 °C`), or just the target if the device has not reported yet.
- The **Ready by** time the task is aiming for.

If you have more than three active Smart tasks, a small `+N in Smart tasks` line appears at the bottom — the full list lives in the **Smart tasks** tab inside PELS.

### Tap a task to see its progress

Tap any row to open a compact **progress trajectory**: the planned line (where PELS expects the device to be heading toward its target) overlaid with the measured line (where it actually is so far), against a dashed target reference. A colour-coded legend names each line and the target value, so you can see at a glance whether a task is keeping up with its plan or falling behind.

![Smart tasks widget detail: a planned-vs-measured progress trajectory for an at-risk task, with the measured line tracking below the plan toward a dashed target line](/screenshots/widgets/smart-tasks-detail.png)

### Recently ended tasks

Below the active list, a **Recently ended** section shows tasks that finished in the last 24 hours — whether they reached their target, missed it, or were cancelled — each with an outcome chip and the time it ended. Tap one to see how the run actually played out against its plan.

![Smart tasks widget: a Recently ended section listing a succeeded and a missed task, and the trajectory detail of a succeeded EV charge reaching its target](/screenshots/widgets/smart-tasks-ended.png)

The widget refreshes about every 60 seconds.

## New smart task

Answers **"get this device ready by a time — without building a Flow."**

An interactive widget that creates a Smart task in a few taps: pick an eligible device (thermostat, water heater, or EV charger), set the goal and a **Ready by** time, then preview and confirm. The preview shows the hours PELS would pick, the estimated cost, and a price curve with the chosen hours highlighted. An optional **Extra permissions** section lets a task go over the daily budget or limit lower-priority devices — both still stay within the hard cap.

![New smart task widget, step 1: choosing an eligible device](/screenshots/widgets/new-smart-task-1-pick-device.png)
*Step 1 — pick an eligible device.*

![New smart task widget, step 2: setting the goal temperature and a ready-by time](/screenshots/widgets/new-smart-task-2-set-goal.png)
*Step 2 — set the goal and a **Ready by** time (with optional **Extra permissions**).*

![New smart task widget, step 3: the preview with estimated cost and a price curve highlighting the chosen hours](/screenshots/widgets/new-smart-task-3-preview.png)
*Step 3 — preview the cost and chosen hours, then confirm.*

The preview is honest about whether the task can be created:

- **Cannot finish** means the widget blocks creation for that ready-by time.
- **At risk** means creation is allowed, but the task may need most of the available window.
- **Satisfied** means the device already meets the goal.
- If PELS cannot preview yet, the widget says which input is missing where possible, such as prices, a current reading, or price-aware planning.

This is the dashboard equivalent of the **Add charging task** / **Add heating task** Flow cards; see [Smart Tasks](/smart-tasks) for how a task behaves once it exists.

## Held-back devices

Answers **"why isn't this running — and can I let it now?"**

The widget lists devices PELS is currently holding back (paused or limited) and the reason. For a device held back by today's daily budget, you can tap **Let it run now** to create a short Smart task with budget leeway. Capacity, manual, and external-service rows stay informational because the hard cap is physical and cannot be bypassed from the widget.

![Held-back devices widget listing devices PELS is holding back, with a Let it run now button on the budget-held row](/screenshots/widgets/held-back-1-list.png)
*Step 1 — the held-back list. Only a budget-held device offers **Let it run now**.*

![Held-back devices widget confirm step, showing the cost estimate and scheduled hours for the rescue](/screenshots/widgets/held-back-2-confirm.png)
*Step 2 — confirm the bounded, budget-exempt run.*

## When to use which

- **Available power** — a constant read on capacity pressure when you run heavy loads (an EV charger, a sauna, a wallbox heater).
- **Budget and Price** — to see where today's energy and cost will land, and which hours are cheapest.
- **Smart tasks** — when you depend on deadlines; the widget turns red before you'd otherwise notice a miss.
- **New smart task** — to set a one-off ready-by goal without opening the app or building a Flow.
- **Held-back devices** — to understand why something is not running right now, and optionally let one budget-held device run now.

All widgets read from the same data PELS already maintains for the app itself, so adding them costs nothing in extra polling or device traffic.
