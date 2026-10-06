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
imminent — manual action needed*) fires only when PELS projects the **selected-period hard cap**
will be exceeded **and it has run out of managed load it is allowed to turn down**.
It is the one urgent, safety-level alert in PELS — everything else is soft pacing.

What to do, in order:

- **Look for a device with Power-limit control turned off.** The most common
  cause is that a large load PELS *could* have eased off is excluded. Turn its
  **Power-limit control** back on (Settings → Devices → the device → Setup) so
  PELS can lower it next time.
- **Reduce fixed load you're running by hand.** If the breach is from
  unmanaged usage (an oven, a kettle, a charger PELS doesn't control), the only
  immediate fix is to use less at once for the rest of the capacity period.
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
- **Review device** — any other last blocker: the device stopped taking power,
  not enough available power was left, a higher-priority device took the room, or
  the plan did not leave enough time. The cause sentence on the entry names it.
  The button deep-links to the device settings; check stepped-load planning power,
  target temperature, priority, **When limiting** behaviour, and the Flow that
  reports state back to PELS. A device that stopped taking power may also have
  switched itself off, which no PELS setting changes.
- **No button** — the car itself held the run back: it stopped at its own charge
  limit, or delayed charging on its own schedule or smart charging. The fix is in
  the car: raise its charge limit, or turn off its own schedule.

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
- **A Smart task releases an hour.** With Power-limit control on, PELS holds the
  device off for that hour. With it off, PELS uses the task's configured release
  behavior. An hour the task keeps without planned energy is different: the
  device runs there when power turns out to be available. When no active
  task controls a device, Power-limit control on allows normal
  run-when-power-is-available behavior.
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
- **Meter chosen?** Check that it is available in Homey Energy and its
  reading is still changing. A selected meter that stops reporting is never
  silently replaced by another one.
- **Using a Flow?** Make sure a Flow calls **Report power usage** (in watts)
  every time your meter updates.

### What PELS does while readings are missing

A short gap changes nothing. PELS counts a reading as current for **60
seconds**, and beyond that it carries the last good one forward and keeps
acting on the decision it already made. A missing reading is never counted as
zero.

After **10 minutes with no new reading**, PELS fails closed rather than keep
trusting a decision it made before the meter went quiet. It limits every
managed device to its floor (lowest step, limited setpoint, or off) and pauses
planning until a new reading arrives, so a meter that has quietly stopped is
worth fixing promptly.

A meter that keeps reporting exactly the same number can count as stopped too,
when your devices show it should have moved. PELS watches the managed devices
that report their power. If their combined draw changes by a kilowatt or more
and stays that way while the whole-home reading keeps exactly the same value,
the banner warns you after two minutes, and after ten minutes PELS treats the
meter as stopped. That is a meter that has stopped updating, for example a
HAN/P1 reader that lost contact with the electricity meter while its app keeps
showing the last value. A steady reading on its own is never treated as stopped,
and nor is exactly 0 W, which a meter that cannot show export reports for as
long as your home exports. So a meter stuck at 0 W is not caught, and nor is one
that freezes while none of your managed devices reports its power (W): one that
reports only the energy it has used (kWh) does not count, because that figure
trails behind. A meter that normally holds a value for twenty minutes or more
(one that reports only on change) is not checked this way, and nor is any meter
while a battery, or a solar inverter that is producing, is connected to Homey:
either can keep the grid reading still while a device switches.

In **Simulation mode** nothing is switched. PELS still shows what it would
limit, and planning carries on as usual.

The banner above the Overview tells you which state you are in:

| Banner | Meaning |
| --- | --- |
| **No power readings yet.** | PELS has never received a reading. |
| **No new power readings in the last minute.** | Readings have stopped, or keep the same value while your devices' power changes. |
| **No new power readings for over 10 minutes. Managed devices stay limited until a new reading arrives.** | PELS has limited every managed device and is waiting for a new reading. |

## No price data, or cheap hours aren't being used

- Confirm a **Price source** is selected and shows data available (Settings →
  Electricity prices).
- On the **Homey Energy** source, check the status card on that same page. If it
  reads **Not usable** or **No usable prices**, PELS could not work out your
  price setup and has paused prices on purpose. Simplify the formula under
  **Energy > Electricity** in Homey. **Not read yet** means PELS has not reached
  Homey; press **Refresh prices**. PELS never falls back to the bare market
  price, because that would look plausible and be too low every hour.
- For the **Flow** source, the external payload must contain full-day JSON.
- On the **Power by the Hour** source, the status card names what is wrong. **No prices
  from the app** means that app is missing, stopped, or older than 8.10.0 (the version
  that started sharing prices) — check it in Homey, then press **Refresh prices**.
  **No price devices** means it is running but has no electricity price device yet.
  **No device chosen** / **Price device is gone** means PELS needs you to say which of
  its price devices prices your home. Prices only start at the hour you pick the source;
  earlier hours of that day stay blank, which is normal.
- For price-based temperature shifts, the device needs **Price** (or **Setup → Price-based control**)
  enabled and **When the temperature changes outside PELS** set to **Return to mode target**, and
  **Respond to prices** must be on globally.
- A Smart task that stays at **Building plan…** is usually waiting for prices
  through its ready-by time — tomorrow's prices may not be published yet.

## EV charging starts at the wrong time or won't change current

- **Charging current never changes:** confirm the charger is configured as
  **EV 1-phase** or **EV 3-phase**. For Easee, check the path you chose:
  **Use built-in device control**, or the existing current-control Flow. For
  other chargers, re-check the **EV charger current (A)** Flow in
  [Configure an EV Charger](/ev-charger).
- **The charger starts outside the plotted task plan:** an active task keeps
  some hours without planned energy (cheaper than its planned hours, or needed
  because it cannot finish otherwise) and charges there when power is available;
  a deferred hour is held off. Turn **Power-limit control** off to prevent normal
  run-when-power-is-available behavior when no active task controls the charger.
  See [Smart Tasks → Power-Limit Control and Tasks](/smart-tasks#power-limit-control-and-tasks).
- **Battery percentage doesn't appear:** if the value lives on the car device
  rather than the charger, use **Report battery level for charger**.

## My battery is stuck in Homey or API mode

While PELS holds your home battery, the battery's own app shows its Homey or API
mode. That is PELS at work: the battery's card on the Overview reads
**Supplying**, **Charging** or **Limited · Charging** and says why. When the
job is done, PELS hands it back to the mode it was in; after a limit, that
happens at the battery's turn in your priority order, once your home has room
for it to charge again. PELS also hands it back at once if your meter stops
reporting, and when PELS restarts.

- **Want it back now?** Turn off **Managed by PELS** on the battery's device
  page (Settings → Devices → the battery). PELS hands it back and leaves it alone.
- **Changed the mode in the battery's app?** PELS takes that as your decision and
  turns **Managed by PELS** off for the battery. Turn it on again when you want
  PELS to use the battery.
- **Uninstalled PELS while it held the battery?** Switch the mode back in the
  battery's own app.

## PELS isn't using my battery

Check these, in order:

- **Managed by PELS is off.** Turn it on for the battery (Settings → Devices).
  If the device page shows a notice that you changed its mode in the battery
  app, PELS stepped back on purpose; turning **Managed by PELS** on again hands
  the battery to PELS.
- **Power-limit control is off.** The battery then only stores your spare solar,
  and its card reads `PELS uses it only to store spare solar`. Turn on
  **Power-limit control** so it can hold your limit on its turn.
- **The battery is in a [meter area](/meter-areas).** A battery in a meter area
  keeps its own mode; PELS uses batteries in the Main home.
- **Simulation mode is on.** PELS leaves every battery in its own mode while
  simulating (Settings → Simulation mode).
- **A Sessy signed in with its cloud login.** PELS needs the local login in the
  Sessy Homey app to switch the battery to API control. Its card then reads
  "PELS can only watch it: its app does not accept control". Switch the battery
  to its local login in that app; PELS tries again after six hours or when it
  restarts.
- **The battery's app cannot take commands from Homey.** PELS needs an app that
  lets Homey set the battery's charge and discharge power, and offers a Homey or
  API mode. Sessy and Marstek Venus are examples of apps that do.

The card reads `PELS takes over when your limit or solar needs it` when
everything is set up and PELS simply has no job for the battery right now. Its
place in your priority order matters too: a battery high in the list only
discharges once the devices below it are limited. See
[Solar and a home battery](/use-cases/homey-solar-home-battery).

## My battery's night charge stopped

If your battery charges from the grid on its own schedule, for example in cheap
night hours, that charging is a load like any other. When your home nears its
limit, PELS limits in priority order, and the battery's charging is capped at its
place in the list: its card reads **Limited · Charging** with
`Waiting to charge faster`. This is how your car or heating keeps running instead.
The charge comes back in priority order once your home has room, and the battery
returns to its own schedule.

To let the night charge go ahead of other devices, move the battery up in your
priority list (its device page → **Reorder**, or the **Modes** page). To keep
PELS from ever capping it, turn off **Power-limit control** on the battery; it
still stores your spare solar.

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
