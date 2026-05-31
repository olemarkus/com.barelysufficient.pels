---
title: Dashboard Widgets
description: Pin PELS widgets to a Homey dashboard to watch available power, today's budget, and Smart task progress — and to start or release a device — without opening the app.
---

# Dashboard Widgets

PELS ships five small widgets you can pin to a Homey dashboard. Most show status at a glance and refresh on their own; two are interactive — **New smart task** lets you create a task and **Held-back devices** lets you release one — straight from the dashboard.

Add any widget from your Homey dashboard's widget picker, then place it where you want.

## Available power

Answers **"how much room do I have right now?"**

The widget shows:

- Current draw against the current effective hour budget, with a coloured bar that turns warning at 85 % and danger at 100 %.
- Available power remaining in the current hour.
- The number of devices PELS is holding back, when any are.
- A price-level chip when prices are cheap or expensive (hidden when prices are normal).

It refreshes about every 10 seconds and keeps showing the last known reading (dimmed) if Homey briefly misses a measurement, so the widget never blanks during a transient hiccup.

## Budget and Price

Answers **"where will today land?"**

The widget shows today's hourly plan as a chart — managed and background usage against the daily budget — with the cheaper and more expensive hours marked, a now-line, and a projected end-of-day total in kWh and money. Use it to see at a glance whether the day is tracking to plan and which hours are the cheap ones.

## Smart tasks

Answers **"are my deadlines on track?"**

The widget lists up to three active Smart tasks, ranked by how much attention they need: tasks PELS expects to miss first, then at-risk, then pending, then on-track. Satisfied tasks drop off automatically.

Each row shows:

- Device name and the status chip (for example **Cannot finish**, **At risk**, **Scheduled**, **On track**, or **Unplugged**).
- The current value moving toward the target (for example `19 °C → 21 °C`), or just the target if the device has not reported yet.
- The **Ready by** time the task is aiming for.

If you have more than three active Smart tasks, a small `+N in Smart tasks` line appears at the bottom — the full list lives in the **Smart tasks** tab inside PELS.

The widget refreshes about every 60 seconds.

## New smart task

Answers **"get this device ready by a time — without building a Flow."**

An interactive widget that creates a Smart task in a few taps: pick an eligible device (thermostat, water heater, or EV charger), set the goal and a **Ready by** time, then preview and confirm. The preview shows the hours PELS would pick, the estimated cost, and a price curve with the chosen hours highlighted. An optional **Extra permissions** section lets a task go over the daily budget or limit lower-priority devices — both still stay within the hard cap.

The preview is honest about whether the task can be created:

- **Cannot finish** means the widget blocks creation for that ready-by time.
- **At risk** means creation is allowed, but the task may need most of the available window.
- **Satisfied** means the device already meets the goal.
- If PELS cannot preview yet, the widget says which input is missing where possible, such as prices, a current reading, or price-aware planning.

This is the dashboard equivalent of the **Add charging task** / **Add heating task** Flow cards; see [Smart Tasks](/smart-tasks) for how a task behaves once it exists.

## Held-back devices

Answers **"why isn't this running — and can I let it now?"**

The widget lists devices PELS is currently holding back (paused or limited) and the reason. For a device held back by today's daily budget, you can tap **Let it run now** to create a short Smart task with budget leeway. Capacity, manual, and external-service rows stay informational because the hard cap is physical and cannot be bypassed from the widget.

## When to use which

- **Available power** — a constant read on capacity pressure when you run heavy loads (an EV charger, a sauna, a wallbox heater).
- **Budget and Price** — to see where today's energy and cost will land, and which hours are cheapest.
- **Smart tasks** — when you depend on deadlines; the widget turns red before you'd otherwise notice a miss.
- **New smart task** — to set a one-off ready-by goal without opening the app or building a Flow.
- **Held-back devices** — to understand why something is not running right now, and optionally let one budget-held device run now.

All widgets read from the same data PELS already maintains for the app itself, so adding them costs nothing in extra polling or device traffic.
