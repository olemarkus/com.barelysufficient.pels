---
title: "Troubleshooting: When PELS Isn't Doing What You Expect"
description: Fixes for the most common PELS problems — a device that won't limit or resume, a Manual action needed alert, a missed Smart task, a budget overshoot, or missing power and price data.
---

# Troubleshooting

Something not behaving the way you expected? Start here. Find the line that sounds
like what you're seeing, check the likely cause, and follow the fix. Most issues
come down to one of a handful of settings.

If you arrived from a Homey notification, jump straight to the matching section:
[Manual action needed](#manual-action-needed), [a Smart task missed](#a-smart-task-missed-its-target),
or [a budget overshoot](#i-went-over-my-daily-budget).

::: tip One rule worth knowing up front
The **hard cap** is your grid tariff step (effekttrinn) — the hourly average
you've decided no hour should exceed, not a tuning knob. When PELS runs short of
room, the answer is to give it *less* to do (a lower daily budget, fewer competing
devices), **never** to raise the hard cap. Raising it just moves you into a more
expensive tariff step. See [hard cap](/glossary#hard-cap).
:::

## PELS isn't limiting or turning down a device

PELS only acts on devices it is allowed to act on. For a managed device to be
lowered, paused, or turned off, three things must all be true:

1. **Managed by PELS** is on for the device (Settings → Devices).
2. **Power-limit control** is on (Settings → Devices → the device → Setup).
3. The device's home isn't simulating. For a Main-home device that means
   **Simulation mode** is off (Settings → Simulation mode) — in simulation PELS
   calculates what it *would* do but never switches anything. For a device in a
   [meter area](/meter-areas) it means that area's **Control devices in this
   area** switch is on (Settings → Limits & safety → pick the area); new areas
   start with it off, so they only simulate until you turn it on. The two are
   independent: an area can be actively limiting while Simulation mode is on,
   and it can be simulating while Simulation mode is off.

A device with **Power-limit control** turned off stays under PELS's planning but
is never limited to protect the hard cap. If a device also has no usable power
estimate, PELS cannot use power-limit control for it — set an accurate load under
the device's Energy settings in Homey. See [Configuration → Devices](/configuration#settings-devices).

## Manual action needed

The **"Manual action needed"** notification (Flow trigger *Hard cap breach
imminent — manual action needed*) fires only when PELS projects the **hourly hard cap**
will be exceeded **and it has run out of managed load it is allowed to turn down**.
It is the one urgent, safety-level alert in PELS — everything else is soft pacing.

What to do, in order:

- **Look for a device with Power-limit control turned off.** The most common
  cause is that a large load PELS *could* have eased off is excluded. Turn its
  **Power-limit control** back on (Settings → Devices → the device → Setup) so
  PELS can lower it next time.
- **Reduce fixed load you're running by hand.** If the breach is from
  unmanaged usage (an oven, a kettle, a charger PELS doesn't control), the only
  immediate fix is to use less at once for the rest of the hour.
- **Don't raise the hard cap.** It reflects the tariff step you're holding. If breaches are
  routine, the real fixes are bringing more big loads under management or pacing
  the day with a [daily budget](/daily-budget).

Once you have worked through those causes, if brief spikes still make it fire more
often than you want, swap the Flow to *Hard cap breach imminent for at least...* and
choose how long the situation has to last first. PELS limits managed devices
immediately either way — this only decides when your Flow starts.

## I went over my daily budget

The daily budget is a **soft pacing target**, not an alarm — going a little over,
especially late in the day, is not a problem and never triggers an urgent alert.
PELS simply paces the home so it *tends* to land on plan.

If you overshoot often and want to land closer to plan:

- **Lower the daily budget** so PELS reserves usable power earlier in the day
  (Budget tab → Adjust, or the **Set daily budget** Flow card).
- Set **Background usage reserve** to `Conservative` if unmanaged household load
  keeps eating the budget (Budget → Adjust → Budget shaping).
- Remember a budget caps **energy (kWh), not money** — on an expensive day a low
  budget can still cost more. The savings come from *shifting* load into cheap
  hours. See [Daily Energy Budget](/daily-budget#what-a-budget-saves-you-an-example).

## A Smart task missed its target

When the **History** view shows a missed run, PELS surfaces one of two recourse
buttons that tell you what to investigate:

- **Lower daily budget** — the day's energy budget ran out before the ready-by
  time and closed down hours PELS had scheduled. Lower the daily budget so future
  days reserve power earlier. (Raising the hard cap is *not* the fix — it just
  costs you a higher tariff step.)
- **Review device** — the device couldn't deliver enough, capacity pressure
  shortened the usable hours, or a replan reduced the window. The button deep-links
  to the device settings; check stepped-load planning power, target temperature,
  priority, **When limiting** behaviour, and the Flow that reports state back to
  PELS.

If a task is **At risk** before the deadline and the timing matters, grant it
extra leeway with **Set what a smart task may do** — *go over today's budget*,
*limit lower-priority devices*, or *pause lower-priority devices* (which reserves
power so the task can start sooner). All three stay inside the hard cap. See
[Letting a Task Push Harder](/smart-tasks#letting-a-task-push-harder).

A run marked **Abandoned** usually needs no fix — it means the situation changed
(the task was cleared, or an EV unplugged past the grace window) rather than a
planning failure.

## A device won't resume / stays paused

- **It's waiting for available power.** After limiting, PELS resumes devices in
  priority order as room opens up, with a short cool-down between steps (60–300
  seconds). A device low in the priority order resumes last.
- **The day is ahead of the daily budget.** When you're over the daily pace, PELS
  holds resumes back a little longer. Check the Budget tab; if it's frozen over
  plan, that's expected until usage drops back under plan.
- **A Smart task with Power-limit control off** keeps a device idle outside its
  planned hours by design — common for EV chargers. That's not a fault.
- **It was turned off elsewhere and PELS was asked to respect that.** If the
  device's Overview card says *Turned off elsewhere — turn it on to resume*,
  PELS is honouring an off action that did not come from it. Turn the device on in Homey or on the
  device to hand it back, or turn off **Leave off until turned on again** in the
  device's **Setup** section. Note PELS only sees an off action your device's
  Homey integration reports — a physical switch that stays silent is invisible.

See [Plan States](/plan-states) for what each Overview state word (Limited,
Resuming, Idle, Off, Manual, and more) means.

## No power data, or the Overview is empty

PELS plans on a live whole-home power reading. If the Overview shows nothing:

- **Using Homey Energy?** Confirm **Power source** is set to **Power meter**
  and a meter is chosen under **Whole-home meter** (Settings → Limits &
  safety). See [Using Homey Energy](/homey-energy).
- **Meter chosen?** Check that it is available and still reporting power in
  Homey Energy — a selected meter that stops reporting is never silently
  replaced by another one.
- **Using a Flow?** Make sure a Flow calls **Report power usage** (in watts)
  every time your meter updates.

### What PELS does while readings are missing

A short gap changes nothing. PELS counts a reading as current for **60
seconds**, and beyond that it carries the last good one forward and keeps
acting on the decision it already made. A missing reading is never counted as
zero.

After **10 minutes with no reading**, PELS fails closed rather than keep
trusting a decision it made before the meter went quiet. It limits every
managed device to its floor (lowest step, limited setpoint, or off) and pauses
planning until a reading arrives. Devices stay limited until the meter reports
again, so a meter that has quietly stopped is worth fixing promptly.

In **Simulation mode** nothing is switched. PELS still shows what it would
limit, and planning carries on as usual.

The banner above the Overview tells you which state you are in:

| Banner | Meaning |
| --- | --- |
| **No power readings yet.** | PELS has never received a reading. |
| **No power readings in the last minute.** | Readings have stopped. |
| **No power readings for over 10 minutes. Managed devices stay limited until readings return.** | The fail-closed pass has run. |

## No price data, or cheap hours aren't being used

- Confirm a **Price source** is selected and shows data available (Settings →
  Electricity prices).
- For the **Flow tag** source, the external payload must contain full-day JSON.
- For price-based temperature shifts, the device needs **Price** (or **Setup → Price-based control**)
  enabled, and **Respond to prices** must be on globally.
- A Smart task that stays at **Building plan…** is usually waiting for prices
  through its ready-by time — tomorrow's prices may not be published yet.

## EV charging starts at the wrong time or won't change current

- **Charging current never changes:** confirm the charger is configured as
  **EV 1-phase** or **EV 3-phase** and the Flow uses the **EV charger current (A)**
  tag. Re-check the current-control Flow in [Configure an EV Charger](/ev-charger).
- **The charger starts in an expensive hour on its own:** turn **Power-limit control**
  off so charging only happens during planned Smart task or Flow-booked hours.
  See [Smart Tasks → Power-Limit Control and Tasks](/smart-tasks#power-limit-control-and-tasks).
- **Battery percentage doesn't appear:** if the value lives on the car device
  rather than the charger, use **Report battery level for charger**.

## A device doesn't appear in PELS

- The device must expose a supported capability and device class (a temperature
  target, an on/off, or a recognised EV charger). Check
  [Configuration → Devices](/configuration#settings-devices).
- If expected usage looks wrong, verify **Device → Advanced Settings → Energy**
  in Homey so PELS has an accurate power estimate.

## Still stuck?

If a problem doesn't fit any of these, the [Technical Reference](/technical)
explains the underlying behaviour, and you can ask or report an issue on
[GitHub](https://github.com/olemarkus/com.barelysufficient.pels). When reporting,
say what you expected, what happened, and which devices and settings are involved.
