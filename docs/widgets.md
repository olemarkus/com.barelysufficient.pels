---
title: Dashboard Widgets
description: Pin PELS widgets to a Homey dashboard to glance at available power and Smart task progress without opening the app.
---

# Dashboard Widgets

PELS ships two small widgets you can pin to a Homey dashboard for at-a-glance status. They sit next to your other tiles and refresh on their own — no taps needed to read them.

Add either widget from your Homey dashboard's widget picker, then place it where you want.

## Available power

Answers the question **"how much room do I have right now?"**

The widget shows:

- Current draw against the current effective hour budget, with a coloured bar that turns warning at 85 % and danger at 100 %.
- Available power remaining in the current hour.
- The number of PELS-paused devices, when any are paused.
- A price-level chip when prices are cheap or expensive (hidden when prices are normal).

It refreshes about every 10 seconds and keeps showing the last known reading (dimmed) if Homey briefly misses a measurement, so the widget never blanks during a transient hiccup.

## Smart tasks

Answers the question **"are my deadlines on track?"**

The widget lists up to three active Smart tasks, ranked by how much attention they need: tasks PELS expects to miss first, then at-risk, then pending, then on-track. Satisfied tasks drop off automatically.

Each row shows:

- Device name and the status chip (for example **Cannot finish**, **At risk**, **Scheduled**, **On track**, or **Unplugged**).
- The current value moving toward the target (for example `19 °C → 21 °C`), or just the target if the device has not reported yet.
- The **Ready by** time the task is aiming for.

If you have more than three active Smart tasks, a small `+N in Smart tasks` line appears at the bottom — the full list lives in the **Smart tasks** tab inside PELS.

The widget refreshes about every 60 seconds.

## When to use which

- Pin **Available power** if you want a constant read on capacity pressure — useful when you're running heavy loads (an EV charger, a sauna, a wallbox heater) and want to know at a glance whether PELS is keeping up.
- Pin **Smart tasks** if you depend on deadlines — overnight EV charging, water heater ready by morning, room warm by a set time. The widget turns red before you'd otherwise notice a miss.

Both widgets read from the same data PELS already maintains for the app itself, so adding them costs nothing in terms of additional polling or device traffic.
