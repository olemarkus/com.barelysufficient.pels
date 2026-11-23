---
title: "Settings Guide — Limits, Devices, Modes & Prices"
description: What each PELS settings page does and which controls matter most for a reliable setup.
---

# Configuration

The PELS settings UI is organized around five top-level destinations:

| Destination | Use for |
| --- | --- |
| **Overview** | Current power, the limit PELS is working to, and what PELS is doing right now. |
| **Budget** | Daily budget plan, today/tomorrow planning, and budget adjustments. |
| **Usage** | Hourly and daily energy history. |
| **Smart tasks** | Current and past ready-by tasks. |
| **Settings** | Limits, devices, modes, prices, simulation, and advanced tools. |

Most configuration starts in **Settings**. The Settings landing page links to **Setup & recommendations**, **Limits & safety**, **Daily budget**, **Devices**, **Modes**, **Electricity prices**, **Price-aware devices**, **Weather insight**, **Multiple meters**, **Simulation mode**, **Open in a browser**, **Activity**, **Report a problem**, and **Advanced**.

## Overview

The Overview page shows the current plan: what PELS wants each managed device to do right now.

| Field | What it shows |
| --- | --- |
| **Power now** | Current whole-home power draw. |
| **Safe pace now** | The current pace PELS reacts around. It comes from the selected-period hard cap or the daily budget, whichever is tighter. When the grid import limit is the tighter one, the Overview names it instead. |
| **Hard cap** | The average power you don't want the configured capacity period to exceed. |
| **Device cards** | Running, Idle, Off, Limited, Resuming, Manual, or Unavailable. |
| **Status line** | Short explanation of why PELS is waiting, limiting, or resuming. |

Use **Overview** when you want to understand live behavior. Use **Settings** when you want to change setup.

For the planner-state mapping, see [Plan States](/plan-states).

## Budget

The Budget page is the daily planning surface. It shows whether the selected day is on plan (**Plan** view) and lets you preview and apply changes to the daily budget model (**Adjust** view).

See [Daily Energy Budget](/daily-budget#where-to-configure-it) for the full description of each view and setting (Enable daily budget, Daily budget, Use cheaper hours, Background usage reserve, Managed device flexibility). Read it before changing the advanced tuning values.

## Usage

The Usage page helps you understand what PELS has observed.

- **Today so far** shows hourly kWh for the selected local day.
- **Daily usage** shows daily totals for the last 14 days.
- **Typical day** shows historical hourly patterns.
- **Detailed hourly view** shows lower-level hourly buckets.
- **Solar** (shown when PELS has a solar signal) shows today's **Produced**, **Used at home**, and **Exported**, with the grid cost you avoided and what you earned from export. See [Solar and Self-Consumption](/solar).

The hourly bars split each hour into **managed** device usage and **background** usage, so you can see how much of your consumption PELS can influence.

Hourly data is kept for 32 days, so the whole current month stays hourly. Daily totals are kept for one year. Resetting usage history lives under **Settings > Advanced > Data management**.

**Recover hourly history from Insights** in the same section fills missing hours
of completed days from the selected whole-home meter's hourly Insights for the last 14 days.
Existing usage stays in place. Recovered meter totals have no device split and
count toward the monthly capacity figures. Recovery checks the source against
recorded usage and does not convert older, coarser averages into hourly data.

## Smart Tasks

Smart tasks show devices with an active target and ready-by time. Tasks are created with **New smart task** on the Smart tasks page, the **Smart task** row of a device page's **Temporary** card, Homey Flow cards, or the **Create smart task** dashboard widget, then shown in the settings UI so you can inspect the current plan and history.

| Card or view | What it does |
| --- | --- |
| **Add charging task** | Plans EV charging toward a target battery percentage by a ready-by time. |
| **Add heating task** | Plans heating toward a target temperature by a ready-by time. |
| **Add energy task** | Delivers a set amount of energy (kWh) to a device by a ready-by time. |
| **Create smart task widget** | Creates a task from a Homey dashboard, without a Flow. |
| **Smart tasks list** | Shows current tasks, targets, and ready-by times. |
| **Task plan page** | Shows selected hours, price context, expected work, background usage, and progress. |
| **History** | Shows previous task outcomes. |

See [Smart Tasks](/smart-tasks) for behavior details and [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows) if you prefer a fixed number of cheapest hours instead of a target-based task.

## Settings > Limits & Safety

This is where the grid import limit, the capacity settings and the whole-home power source live.

![PELS Limits and safety settings showing the Grid import limit and Capacity limit switches, Capacity period, Hard cap 8 kW and Safety margin 0.4 kW](/screenshots/settings/limits-safety.png)

| Setting | What it does |
| --- | --- |
| **Grid import limit** | Turn on to keep whole-home net import from the grid under a level you choose, in kW. PELS starts reducing loads near 95% of it and brings them back in priority order when power is available again. It reads the latest meter reading, so a short overshoot is possible while the meter updates and devices respond. It is not a circuit breaker. |
| **Capacity limit** | Turn on when your grid tariff charges for your highest hourly or 15-minute average power. Turn it off if your grid charges do not depend on measured peaks, as in the Netherlands, where the capacity tariff is a fixed charge by connection size, or in France, where it depends on your subscribed power (enter it under **Main fuse**). A new install starts with it on in Norway and Belgium and off everywhere else. |
| **Capacity period** | **Hourly average** for hourly tariffs; **15-minute average** for quarter-hour peak tariffs, such as Belgium's capacity tariff. |
| **Hard cap (kW)** | The average power you don't want the selected period to exceed. Set this from the peak or tariff step you want to protect. If you are not charged for measured peaks, turn off **Capacity limit** instead. |
| **Safety margin (kW)** | Buffer below the hard cap. PELS starts reacting before the hard cap is reached. |
| **Power source** | Where whole-home power readings come from: **Flow card** or **Power meter** (read through Homey Energy). |
| **Whole-home meter** | Shown with the Power meter source. Which meter whole-home power readings come from. PELS always reads one named meter: when the only whole-home meter Homey lists is marked **Tracks total home energy consumption** and no Flow has ever sent PELS readings, PELS picks it on its own shortly after starting; otherwise choose it here. A selection does not need Homey's **Tracks total home energy consumption** marking. The list shows whole-home meters rather than every power-using device, so an EV charger or smart plug won't appear; a meter you chose earlier stays selectable even if it no longer appears. |

For the Main home using Norway prices and an hourly capacity period, **Usage > Monthly capacity** uses the existing hourly import history to show the estimated capacity tier and hourly cap for the remaining month. The **Safety margin** stays below the recommended **Hard cap**: a 4.8 kW Hard cap with a 0.3 kW margin gives a 4.5 kW planning allowance, reserving room for unmanaged load late in the hour. The margin never increases the tariff allowance. Expand **Three highest daily hours** to see the counted days, hours and average. PELS uses your selected grid company's supported three-day tariff and Norway's calendar. Homey's timezone must be Europe/Oslo.

A partially tracked hour appears as **at least**: its recorded import already establishes that minimum hourly average. Missing days are labelled **Not recorded**. The figures use the same hourly history as Usage, rather than starting a separate capacity history when this feature is installed. Missing or unreliable hours are identified in the card.

A single hour above a tier boundary does not necessarily lose the tier. For example, a 5.01 kW day can still fit below a 5 kW three-day average when the other counted peaks are low enough. Later quiet days cannot lower the average of three peaks already recorded.

When an adjustment is useful, Overview links to the monthly detail. **Usage > Monthly capacity** and **Limits & safety** let you apply the suggested Hard cap for this month or return to your normal limit. Your normal Hard cap stays saved and takes effect automatically at midnight in Oslo on the first day of the next month, including after an app restart. Editing it or the safety margin cancels the temporary choice. A lower Hard cap can be applied with incomplete history; an increase requires recorded hours throughout the elapsed month without known gaps. The calculation is an estimate from recorded usage; your grid operator determines the billed tier. Resetting usage history also clears the history used by this calculation.

On the 15-minute period, **Highest completed quarter this month** reports PELS's largest fully tracked 15-minute average for the current month. It is an operational estimate from the readings sent to PELS, not a grid bill or a reproduction of operator rules such as a minimum monthly peak.

When the whole-home meter reports its own monthly peak, as a HomeWizard P1 meter does on a Belgian digital meter, PELS uses the higher of the two and the readout says **Reported by your meter.** when the meter's value is the higher one. That is the peak your grid operator reads, so a peak set while PELS was not running still counts. This applies with the Power meter source, for the Main home and each meter area with its own meter.

Beside it, **Follow this month's peak** suits a tariff that bills the month's highest quarter, as in Flanders. With it on and Capacity limit on, when this month's highest completed quarter is above the hard cap, PELS uses that peak, minus the safety margin, until the month ends: your grid tariff already counts that peak, so holding the house lower saves nothing. The grid import limit and the main fuse never move, and from the 1st of the next month the hard cap you set applies again. While the peak holds, the safe-pace summary on Limits & safety says which peak PELS holds and where safe pace starts, and the Overview's hard cap marker adds `set by this month's peak`. With the switch off and the peak above the hard cap, a line under the peak readout points to the switch. Smart tasks and battery plans use the higher hard cap for intervals before local month-end and your usual cap from the first of the next month. Smart tasks still respect their daily-budget allowance. New installs in Belgium start with it on; for each meter area it is set on its own Limits & safety page.

Each limit is checked against your home's own usage as you edit it. A grid import limit or main fuse below an hour your home averaged in the last 7 days, or below what it uses right now, shows a warning under the field: the hour, its average, and how many hourly averages exceeded the target. A hard cap below the average draw in about 9 of 10 measured hours shows a warning too. A hard cap below your past peaks is what the hard cap is for, so it gets no warning. Saving a lower limit with a warning asks first: **Keep saved limits** puts the form back, **Save anyway** saves it.

Important:

- The selected-period hard cap is the only limit with an urgent manual-action alert. The grid import limit shows its own status on the Overview and does not fire hard-cap Flows.
- The **Hard cap breach imminent — manual action needed** trigger fires only when PELS projects a hard-cap breach in the current capacity period and cannot limit any more load.

## Settings > Devices

The Devices page shows temperature devices, on-off devices, and supported EV chargers. Open a device to configure its detail panel.

![PELS Devices page with Managed, Limit, and Price toggles for an EV charger, heaters, and a thermostat](/screenshots/settings/devices.png)

Top-level controls:

| Control | What it means |
| --- | --- |
| **Managed** | PELS includes this device in modes and plans. Turning it on also turns on **Limit**, when the device has a power reading; turn Limit off again if PELS should plan around the device without lowering it. |
| **Limit** | PELS may lower, pause or turn off this device: to stay under your grid import limit or hard cap, to keep to your daily budget, or to follow your solar surplus. |
| **Price** | PELS adjusts the temperature target around electricity prices. |

Device detail sections. Each switch sits in the section it governs: **Price-based control** heads Price response, the solar switches head Solar surplus, and **Power-limit control** heads Power limiting. **Price response** and **Power limiting** are closed when the page opens, and each header shows what is set, for example `On · +2.5° cheap, −2° expensive` and `On · turns off when limiting`; open one to change it. The page composes per device kind — an EV charger, a thermostat, a stepped load (such as a water heater), and a plain on/off device each lead with the sections that matter for that device, and sections that do not apply are not shown. The top of every managed device's page is a live status header: state, current draw, one fact line (temperature and target, or charging state, battery, and level), the reason the device is limited when it is, and a Smart task link when one is scheduled. A device PELS does not manage has no live status to report, so its page shows no header, and its Setup section starts expanded.

| Section | Shown for | What it contains |
| --- | --- | --- |
| **Temporary** | Devices that can take an override, a Smart task or a schedule | What applies for a limited time, one row each: **Override** (hold a temperature until a time, on thermostats), **Smart task** (add one, or view the one scheduled) and **Schedules** (add one, or see how many the device has and when the next runs). First on the page. |
| **Charging** | Managed EV chargers | When and how much to charge: **Charge to a battery level** (with **Charge before the battery level is known**), charge boost, and **Charge on solar surplus**. |
| **Car** | EV chargers | Which cars charge here, the battery level PELS reads from the car, and where the level comes from. |
| **Temperature per mode** | Temperature devices | Per-mode target temperatures, with each mode's resume priority (reordered in Modes), and **When the temperature changes outside PELS**. |
| **Price response** | Temperature devices | **Price-based control**, then the cheap-hour boost and expensive-hour reduction. |
| **Solar surplus** (prosumer) | Devices that can use solar, in homes with solar | **Use solar surplus** and the **Solar-surplus boost** on a temperature device (how far the target rises while your panels are exporting), **Run on solar surplus** on an on/off device, or **Match solar surplus** on a stepped device. An EV charger has **Charge on solar surplus** in Charging instead. See [Solar and Self-Consumption](/solar). |
| **Stepped load profile** | Stepped loads | Step names, planning power values, target-power range, and temperature boost. Hidden for EV chargers using an EV preset, because the preset owns the steps. On any other EV charger it follows Setup, collapsed, with the number of steps and the highest power in its header. |
| **Power limiting** | All devices PELS can limit | **Power-limit control**, **Only PELS starts this device** and **Leave off until turned on again**; on an EV charger it is hidden while the charger is not managed. How far PELS may go when limiting this device — off, a limited temperature, or a lowest step — when there is a real choice; a device with only one possible limit gets a statement of what PELS does instead of a one-button choice. PELS goes only as deep as it needs. A device that reports whether it is heating or cooling gets a second limit, **Limited temperature when cooling**; see [Limited temperature for a heating and cooling device](/technical#limited-temperature-for-a-heating-and-cooling-device). |
| **Battery** | Home batteries | Managed by PELS, power-limit control, and the battery's place in the priority order (**Reorder**). |
| **Setup** | All devices except home batteries | Managed by PELS, budget exemption, built-in device control, control model, and **Power when running**. Opens automatically for devices that are not managed yet. |
| **Activity log** | All devices | Recent state changes PELS recorded for this device. |
| **Advanced diagnostics** | All devices | Read-only history of waiting time, failed restarts, and restart backoff. |

Selecting a car chooses its matched battery reading as the charger's battery source.
While any car is selected, PELS ignores the **Report battery level for charger** Flow
card. Until a car is matched, the charger
has no battery level. Once a selected car has been matched to the charger,
**Setup & recommendations** flags an enabled Flow that still reports battery level for this
charger, because that action is ignored while a car is selected. While no selected car has
been matched to the charger, it instead warns that the charger has no battery level and
suggests clearing the car selection so the Flow keeps working until the car shows as matched.
If the selected car was removed from Homey, it can never be matched, so Setup says to clear
that selection.
Clear the car selection to use native or Flow battery reporting again.

When a selected car is unavailable in Homey, PELS temporarily removes its association and
battery level because the retained car data cannot be trusted. The charger remains managed
normally. If the car becomes available again while both it and the charger still report a
connection, PELS resumes the association automatically; no physical replug is needed.

![PELS device detail page for a heat pump showing the live status header, Temperature per mode, Price response, Solar surplus, Power limiting, and the Setup section with Managed by PELS, Budget exempt, Control model, and Power when running](/screenshots/device-detail/mw-thermostat-heatpump-full.png)

Notes:

- Power-limit control needs a power reading for the device: its own power meter, or the live value Homey Energy shows for it. Until the first reading arrives, PELS does not limit the device. When a metering socket measures the device, choose it under **External sensors** (see [Measure a device with a metering socket](#metering-socket)). When a temperature device's app reports no power and a sub-meter that is not a socket measures it, see [Limit a Temperature Device Through a Virtual Thermostat](/how-to-virtual-thermostat-power). For a device with custom on/off or pause/resume commands and a separate meter, see [Combine Custom Device Control With an External Power Meter](/how-to-virtual-dishwasher-power).
- For a device PELS can switch on and off, the line under **Power-limit control** says who starts it with your settings. With **Power-limit control** on, PELS limits the device when it must and also turns it on whenever power allows, even after it was turned off elsewhere; turn on **Leave off until turned on again** to keep it off after it is turned off elsewhere. With **Power-limit control** off, PELS does not start the device, and leaves it running when it is started elsewhere. While a smart task is in progress the task decides, and the line begins *When no smart task is running*.
- Temperature devices can still be managed for mode and price behavior even when power-limit control is unavailable.
- A NIBE heat pump paired with the NIBE myUplink app (**Nibe heatpumps**) is a temperature device in PELS once the app shows a room temperature: from the BT50 room sensor on F-series pumps, or the controlling myUplink zone on S-series pumps. PELS sets the room setpoint the app shows as **Target temperature**. An F-series pump follows that setpoint through its room sensor.
- A Stiebel Eltron heat pump paired with the Stiebel Eltron Heat Pumps app appears in PELS as two devices: the heat pump itself, for room heating, and a second device with the same name followed by **hot water**, for the hot-water tank. Each has its own target temperature, so PELS can heat hot water in cheap hours, or lower it to stay under your limit, without touching the room temperature. Make the community registers visible on your ISG, then turn on **ISG supports community registers** in the heat pump's device settings, as the Stiebel app describes, so each device gets its own power reading. Without it neither device has a power reading, and PELS manages them for mode and price only.
- Set **When the temperature changes outside PELS** to **Keep the new temperature** when another app or Flow owns a thermostat's target. PELS keeps showing the measured temperature and target, and never writes the target itself. It still manages capacity with the device's other controls: turning it off and on, and, for a device with power levels such as a compatible water heater, lowering it a level at a time. Saved temperature settings are kept and apply again when you switch back to **Return to mode target**.
- **Built-in device control** lets PELS adjust a supported device, including compatible water heaters and supported EV chargers, without a current-control Flow. When an existing Flow already writes the same setting, PELS keeps that working setup and leaves built-in control off: PELS cannot stop a Flow, and the two would override each other. The switch cannot be turned on while that Flow exists, and if it was on, PELS pauses built-in control until the Flow is gone. **Setup & recommendations** offers an optional migration: disable only the Flow action that controls the device, select **Check again**, then turn on **Use built-in device control**. A Flow that only reads the device, turns it on and off, reports battery level, or adjusts an unrelated setting is not a built-in-control conflict. Battery reporting should remain only when no car is selected for that charger; otherwise PELS flags the ignored action separately.
- Only managed devices appear in **Settings > Modes**. Only managed temperature devices with **Price** enabled appear in **Settings > Price-aware devices**.
- **Power when running** is how much PELS assumes the device draws while it runs, and it decides how much power PELS frees up before resuming it. The field shows the figure PELS is using now and says where it came from — measured by PELS, read from the device, from Homey, or a rough estimate when PELS has no reading yet. Type a value in watts to correct it, or leave it empty to let PELS work it out. It is not shown for stepped loads, which are sized per configured step. If the figure looks wrong and you would rather fix it at the source, check **Device -> Advanced Settings -> Energy** in Homey and verify the configured power usage values.
- For EV current-control setup, see [Configure an EV Charger](/ev-charger).

### Leave off until turned on again

Off by default, and available for devices PELS can switch on and off. It sits
under **Power-limit control** and appears while that is on, because with
Power-limit control off PELS does not turn the device on again anyway.

When it is on and the device is turned off — in Homey, on the device itself, or
from another Flow — PELS leaves it off until it is turned on again. Turning the
device on again hands it straight back to normal PELS control. Devices PELS
turned off itself still resume on their own; this only applies to an off action
that did not come from PELS.

With this setting on, one off that PELS made also counts: a device PELS was
keeping off for **Run on solar surplus**. If you turn **Run on solar surplus** off
while the device is off, PELS leaves it off until it is turned on again, instead
of starting it from the grid. Turning **Run on solar surplus** back on later does
not start it either; turn the device on once, and PELS runs it on surplus again.

On the Overview the device reads **Off** with *Turned off elsewhere — turn it
on to resume*.

It covers on and off only. For a thermostat, PELS keeps setting the temperature
it would set anyway, even while it is leaving the device off; only **Keep the
new temperature** (under *When the temperature changes outside PELS*) stops
that.

A smart task wins over this setting. In the hours the task books, PELS can turn
the device on for it when there is available power, and once the device is on, the
hold has ended: it is back under normal PELS control. In the hours the task does not book, the device stays off.
Turning the device off during a booked hour does not stop the task; PELS can turn it
back on. To keep the device off, open the task and choose **Clear task**. In an automation, use the **Clear smart task** Flow card.

A Flow that turns the device off counts as turning it off elsewhere. That
matters if you book hours with Flows: when the Flow that ends a booked hour turns
the device off, PELS leaves it off, and turning **Power-limit control** back on
is not enough to start it again. The Flow that starts the next booked hour has
to turn the device on as well.

It is worth being clear about how this differs from turning **Power-limit
control** off, since both stop PELS resuming a device:

| | Power-limit control off | Leave off until turned on again |
| --- | --- | --- |
| May PELS limit the device? | No | Yes |
| May PELS resume it? | No, until you switch control back on | Yes, except while it has been switched off outside PELS, unless a smart task books the hour |
| How does it go back to normal? | Re-enable Power-limit control | Turn the device on |
| What it is for | Handing the device to another automation entirely | A temporary override, by you or another automation |

Turning the device on gives control back to PELS; it does not promise the device
keeps running. If power is tight, PELS may limit it again right away.

One limitation worth knowing: PELS can only notice an off action that your
device's Homey integration reports back. A physical switch that does not tell
Homey it was pressed is invisible to PELS.

### Only PELS starts this device

Use it for a device that should run only when a [Smart task](/smart-tasks) needs
it, such as an EV charger that starts charging by itself when the car is plugged
in. With it on, PELS turns the device off again when it is started in Homey, on
the device itself, or from another Flow, and the device runs in the hours its
Smart task picks. Without a Smart task it stays off.

It applies while **Power-limit control** is off. With Power-limit control on,
PELS already decides when the device runs, so the setting is paused; it applies
again when Power-limit control is turned off. It is offered on the device page
while **Power-limit control** is off, once the device has had a Smart task.
**Change** on a Smart task's **When the task is done** card opens the device page
at **Power-limit control**.

### On/off devices without power metering {#device-energy-settings}

A supported device with on/off control can appear on **Devices** and be made **Managed**
before it has power information. PELS shows a setup warning on its device page
and Overview, and does not limit its power use until Homey supplies a power value.
Modes can still adjust a device's temperature target.

Configure the power use in **Homey's device settings**, outside PELS:

1. Open the device in the Homey app and open its device settings.
2. Go to **Advanced settings → Energy**.
3. Set **Energy used when on** to the watts the connected device draws when on.
   Set **Energy used when off** to its standby watts.
4. Return to **Devices** in PELS and choose **Refresh devices**.
5. Turn on **Limit**, or **Power-limit control** on the device page, to let PELS
   limit the device.

PELS uses the power value Homey supplies for the device. The setup warning
clears when Homey has its power information. A device with its own power meter
uses that reading instead.

Two other ways work inside PELS: let a metering socket measure the device
([Measure a device with a metering socket](#metering-socket)), or, for a relay
whose draw nothing can measure, let PELS turn it off only as a last resort
([Last-resort control for an unmetered relay](#last-resort)).

### Measure a device with a metering socket {#metering-socket}

When a device has no power reading of its own, a metering socket it is plugged into can measure it for PELS. Open the device in **Devices**, expand **External sensors**, and choose the socket under **Power source**. Press **Save**, then turn on **Managed by PELS**.

**Power source** reads **None** for a device without a reading and **This device** when the device reports power itself, with its current reading below the field. Choosing a socket for a device that has its own reading replaces that reading.

The socket must report power, be in the same home as the device, and not be managed by PELS. Each socket can measure one device. While it measures a device, PELS never switches the socket, and the socket's card says which device it measures. PELS limits the device through the device's own switch or temperature.

If the socket stops reporting, PELS stops limiting the device until the socket reports again. When you remove a device from Homey, PELS clears its setup, and its socket becomes free for another device.

### Choose which switch PELS uses {#on-off-control}

Some devices have more than one on/off switch, such as a spa with a main switch and a separate heating switch. For such a device, **Setup** shows **On/off control** after **Control model**. Choose the switch and press **Save**. PELS then limits the device with that switch and leaves the others alone. **Default** uses the device's standard switch.

### Set up a device that needs a meter or switch {#add-a-device}

In **Devices** and during first-run setup, look for your appliance under **Needs setup**. Use **Find another device** to search by name when it is not shown. Choose **Set up** next to the appliance. For example, select your spa, choose the socket that measures its power, then choose its heating switch under **On/off control**. Select **Review setup**, then **Add to PELS**. If the meter has not reported yet, choose **Check meter** after it reports.

If PELS already manages the socket, **Use only as a meter** turns off PELS management for the socket. The socket can then measure the appliance while PELS limits it through the selected switch. Devices that are ready to manage still have a **Managed by PELS** toggle.

### Last-resort control for an unmetered relay {#last-resort}

If a relay has no device power reading, choose **Turn off as a last resort** during setup and enter the maximum watts the connected load can draw. For an already listed relay, you can also open its **Power limiting** settings to make this change.

PELS uses the household meter for the load's contribution. It turns off the relay only after ordinary limiting is exhausted, or when the household meter stops reporting. Before it turns the relay back on, it needs room for the full configured maximum. Last-resort devices stay at the top of **Modes**. Order them there to choose which resumes first.

PELS resumes only a switch-off it can still identify as its own. If the device shows **Manual** after a restart, turn the relay back on to resume control.

If the relay starts reporting its own power, PELS still turns back on a relay it switched off, then stops last-resort control for it. Turn off **Turn off as a last resort** to let PELS limit it like any other metered device.

When you remove a device from Homey, PELS clears its setup.

### Missing a device?

**Missing a device?** is the last card on the Devices page. Its **Request support** button lists every device in Homey by zone, with a search field for name or zone. Each row shows the device type, and **On Devices** when PELS already supports it. Tap a device PELS does not support to send a device support request: describe the device and what PELS should do with it, and PELS sends the request through Homey with what Homey reports about the device (its type, its app and its capabilities) and the app's logs. Support for a new device usually comes in an app update within 1–2 days, depending on how complex the device is. To hear back, post in the PELS forum thread and quote the reference PELS shows after sending, or email the developer.

A device marked **On Devices** opens on Devices when tapped, where **Managed** turns on control. The meter PELS reads whole-home power from is marked **Whole-home meter** and opens **Power source**. The device step of the setup journey shows the same card.

## Settings > Modes

Modes let you store different comfort and priority profiles such as **Home**, **Away**, **Night**, or **Vacation**.

![PELS Modes settings showing per-mode priority order and target temperatures, with drag handles to reorder priority](/screenshots/settings/modes.png)

### What changes per mode

For each managed device in a mode:

| Setting | What it does |
| --- | --- |
| **Desired temperature** | Target temperature for the mode |
| **Priority** | Lower number means higher priority. These devices stay on longer and resume first. |

Typical approach:

- Keep living-room comfort high in **Home** mode.
- Move bedroom heating higher during **Night** mode.
- Lower less critical loads in **Away** mode.

Changes save automatically.

## Settings > Electricity Prices

Price support is optional, but it makes the app more useful for thermal loads, daily budget price shaping, Smart tasks, and cheapest-hour Flow cards.

| Setting | What it does |
| --- | --- |
| **Price source** | Choose **Norway (spot + grid tariff)**, **Homey Energy (dynamic prices)**, **Power by the Hour (app)**, or **Flow (prices from a Flow card)**. Until you choose, PELS uses **Norway (spot + grid tariff)** on a Homey in Norway and **Homey Energy** elsewhere, going by the country Homey reports for its location. The page then says **Not chosen yet** with a button to keep that source. Outside Norway, PELS uses **Power by the Hour** instead when that app can price your home (its only price device, or the one you picked) and no device follows prices yet. Once devices follow prices, PELS never moves them to another source by itself, and the page offers **Use Power by the Hour** next to **Keep Homey Energy**. If Homey Energy has no prices for your Homey, the page offers dynamic prices under **Energy > Electricity** where Homey covers your country, Power by the Hour for European market prices and configured markups, or **Use Flow prices** for prices you supply for your contract. Check that a source can represent your tariff. Setup keeps **Prices** open until the selected source has usable prices; Flow needs a price day for today or tomorrow. **Choose what PELS does** returns to device choices, where you can turn off price-based features and use power limits or solar control without prices. |

**Power by the Hour** reads prices straight from that app, with no Flow to build. Install
[Power by the Hour](https://homey.app/a/com.gruijter.powerhour/) (version 8.10.0 or newer), add a price device
for your bidding zone in it, and pick this source. If you have more than one price device, PELS asks which one
prices your home. The prices are the ones that app publishes — the spot price plus the markups you set there —
so the **grid tariff is not included** unless you added it there yourself as a fixed or time-of-day markup.
On a fixed or day/night tariff, turn on **Ignore market price (Fixed price only)** in the price device. Enter
the cheaper rate as **Import fixed markup per kWh** and what the dearer hours add as **Import Extra Time Of Day
markup** (`7:0.08;20:0` adds 0.08 from 07:00 to 20:00). **Import Extra Weekend markup** replaces it only when not
zero, and the app knows no public holidays: change the markup from a Flow on those days.

If you use Norway pricing, you also set:

- county
- grid company
- tariff group
- price area
- pricing model (Strømstøtte or Norgespris)
- provider surcharge
- threshold and minimum difference values

A setting you have not chosen says **Not chosen yet** and what PELS uses in its place, such as NO1 or Strømstøtte. Without a grid company your prices leave out the grid tariff. Choosing another county clears the grid company, because each grid company serves its own counties.

PELS reads your grid company's energy rates from [Fri Nettleie](https://kraftsystemet.no/fri-nettleie/), an open dataset of Norwegian grid tariffs that carries price changes from the day they apply, including changes a grid company has announced ahead. For a grid company Fri Nettleie does not cover, PELS reads the tariff from NVE. If Fri Nettleie cannot be reached, PELS keeps pricing on the tariff it fetched last from there, so the days ahead still follow your grid company's day and night rates and any change it announced.

Grid tariffs from [Fri Nettleie](https://github.com/kraftsystemet/fri-nettleie) are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). PELS adds the Enova fee to them and turns them into hourly prices. Grid tariffs from NVE are licensed under the [Norwegian Licence for Open Government Data (NLOD)](https://data.norge.no/nlod/en/2.0).

When you open **Electricity prices** with the Norway source and no grid company or price area chosen, PELS looks up your Homey's location once and shows **Suggested from your Homey's location**: the grid company whose area your Homey is in, its county, and the price area Homey Energy uses for your Homey. **Use these** saves them as your choices. Nothing is saved until you tap it. To find the grid company and county, PELS sends your Homey's coordinates to NVE (the Norwegian Water Resources and Energy Directorate) and Kartverket (the Norwegian Mapping Authority), only when you open the page with a setting missing.

On the Norway source the **Right now** card shows the price for the current hour and the parts that add up to it, with VAT: the spot price, the Norgespris adjustment that brings it to the fixed price (smaller or none once the monthly cap is used), the grid tariff (with the Enova fee in it), your provider surcharge, taxes (the consumption tax), and, under Strømstøtte, the support taken off. When the grid tariff is not in the price, because no grid company is chosen or its tariff has not been fetched yet, the card says so.

**Cheap and expensive prices** says where your threshold and minimum difference put the lines over the prices PELS knows, for example *Cheap at or below 56.50 øre · expensive from 94.20 øre*. When no price reaches a line, it adds how far the prices stay from it, for example *No cheap or expensive prices: they stay between 73.84 and 87.84 øre.* It then offers the one change that would make the cheapest quarter of the prices count as cheap, for example under Norgespris, where only the grid tariff moves the price. When the threshold is what keeps them normal, it offers a lower one: tap **Use 9 %** (or the percentage shown) to save it. When the minimum difference is, it offers a lower one: tap **Use 9 øre** (or the value shown). PELS suggests nothing below 5 %, nothing that would also mark a price expensive, and nothing when both settings keep the prices normal, since neither change alone would make them cheap.

If you use external flow tags:

1. Set **Price source** to **Flow (prices from a Flow card)**.
2. Feed the full JSON payload for today's prices into **Set external prices (today)**.
3. Feed tomorrow's payload into **Set external prices (tomorrow)** when available.

### Export price (prosumer)

If you sell surplus solar back to the grid, turn on **Use an export price** and set a **share of the spot price** and/or a **fixed amount**.

The fixed amount is in øre on the Norway source and in your currency on the others. When the price source changes, whether you pick another one or PELS switches a Homey outside Norway to Homey Energy, PELS turns the export price off rather than read a fixed amount in the wrong unit, so turn it back on and enter the amount again. A share of the spot price is set to 0 on a source without a spot price.

On the **Homey Energy** price source you also get **Where the price comes from**:

- **Amounts I enter here** — the two amounts above. This is the default, and what every existing setup keeps.
- **Homey Energy** — the export price you already set up in Homey under **Energy > Electricity**. Choosing it replaces the amount fields, because the price then comes from Homey. If Homey has no export price set up, or PELS cannot work out the formula, PELS plans on the import price as it would for a home with no export price at all, and your own amounts are no longer applied, so check **Energy > Electricity** in Homey before switching. See [Getting paid for solar you export](/homey-energy#getting-paid-for-solar-you-export).

On the **Power by the Hour** price source the same choice offers **Power by the Hour**: the feed-in price that app publishes for each period, after the export markups you set on its price device. Without any export markup there, the feed-in price equals the import price, so set those markups first. Choosing it replaces the amount fields here too.

PELS then schedules against the blended **planning price** (what your energy is actually worth once export is accounted for), while your bills, receipts, and the budget's money view stay on the **import price** you are billed. This section appears once PELS can see your solar (a managed solar device reports production, or your meter has recorded about a kilowatt-hour of grid export), and stays visible if you already have an export price configured. See [Solar and Self-Consumption](/solar).

## Settings > Price-Aware Devices

This page adjusts devices that already have price response enabled. To add a device here, first open the device under **Settings > Devices** and enable **Price** or **Price response > Price-based control**.

The page starts with **Prices from**: the price source these devices respond to, marked **Not set up** while PELS prices with a source or a Norway setting you have not chosen, or the source has no prices. The device's **Price-based control** says the same.

| Setting | What it does |
| --- | --- |
| **Respond to prices** | Enables or disables price response globally. |
| **Cheap** (°C) | The device's cheap-hour boost: how far its temperature goes up while power is cheap. |
| **Expensive** (°C) | The device's expensive-hour reduction: how far its temperature goes down while power is expensive. |

Water heaters and similar thermal loads are usually the best first candidates.

## Settings > Simulation Mode

Simulation mode lets you test behavior without switching devices.

| Setting | What it does |
| --- | --- |
| **Simulation mode** | PELS shows what it would do, but Main home devices are not switched automatically. |

Use this while you are tuning priorities, power estimates, and limits. Turn it off when you are ready for PELS to control devices.

While simulating, PELS paces each hour (or quarter) and your daily budget as if the devices it would limit had been limited, so for the rest of the hour it keeps showing what it would do with control on. **Energy used this hour** (**this quarter** with quarter-hour limits) still shows what your meter measured, and the line under it shows the energy with control on, which the projection follows. A home battery is planned the same way: it stays in its own mode, and its card says what PELS would have it do.

Simulation mode covers your Main home. Each [meter area](/meter-areas) has its own **Control devices in this area** switch under **Limits & safety**, so an area can keep limiting its devices while Simulation mode is on.

## Settings > Report a problem

Describe what happened and send the report. PELS adds relevant device activity and current state. Opening the form from a device, Smart task or Activity entry keeps that context; an Activity entry also sets the incident time.

Problem reports and device-support requests use the same sending and follow-up flow. Sending the report is all the developer needs. If you would like an answer, post in the PELS forum thread and quote the report reference, or email the developer. The email link includes your description and the report reference. Copying the diagnostic report is available if Homey cannot send it.

## Settings > Advanced

Advanced is for diagnostics, cleanup, and expert tuning.

| Setting | What it does |
| --- | --- |
| **Debug logging** | Turns on the log streams for the scenarios you are investigating. |
| **Diagnostics reports** | **Send a daily diagnostics report**, or **Send a report on specific events**, to the developer. |
| **Reset usage history** | Clears hourly samples, daily totals, and weekday/weekend averages. |
| **Clear device data** | Removes stored PELS metadata for one selected device. |
| **Device log** | Writes a selected Homey device payload to the app logs for inspection. |

**Background usage reserve** and **Managed device flexibility** are edited in the Budget page's Adjust view (Budget shaping section), reachable from the Budget page header or the **Daily budget** row in Settings. Only change them if you understand the tradeoff — they can materially change when devices are limited and resumed.

For the exact formulas, see [Daily Budget Weighting Math](/daily-budget-weights).

## Suggested setup order

Follow [Getting Started](/getting-started) to confirm your meter, choose one device, review the settings for your home, then preview and start managing. Setup offers the controls your device supports. You can add more devices, change priorities or enable a [daily budget](/daily-budget) later.

