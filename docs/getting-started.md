---
title: Getting Started
description: Install PELS on Homey Pro, connect your power meter, set a capacity limit, and get your first useful setup running.
---

# Getting Started

PELS is a Homey app that intelligently manages your heavy electrical loads. It keeps your power usage within your hourly limit, decides which devices to turn down first, can plan Smart tasks, and can shift flexible load to cheaper hours automatically.

In practice, most users spend their time in **Apps -> PELS -> Settings** and a small number of Homey Flows.

If PELS is not installed yet, get it from the [Homey App Store](https://homey.app/a/com.barelysufficient.pels).

## Before you begin

- PELS must already be installed on your Homey Pro.
- You need a whole-home power meter paired with Homey (e.g. Tibber Pulse, AMS/HAN reader, P1 reader, Shelly EM) or another Flow source that can report current load in watts.
- You should know which devices in your home use the most power and can tolerate being turned down temporarily.

## Open PELS settings

Open **Apps -> PELS -> Settings** in Homey. This is where all configuration happens.

## Step 1: Connect your power meter

Without live power input, PELS cannot know how much power your home is using.

**Easiest path — use Homey Energy.** If your power meter is paired with Homey and has **Tracks total home energy consumption** enabled in its device settings, no Flow is needed. Go to **Settings > Limits & safety** and set **Power source** to **Homey Energy**. PELS starts polling automatically. This works for any meter Homey recognises as a whole-home tracker — Tibber Pulse, P1/HAN readers, Shelly EM, and similar.

See [Using Homey Energy](/homey-energy) for the full walkthrough, including how to also read electricity prices from Homey Energy (especially useful outside Norway).

**Alternative — feed power via Flow.** If your meter is not in Homey Energy, or you want to combine sources before sending the value to PELS, create a Homey Flow that calls the **Report power usage** action whenever your meter updates. Input is current power in watts.

Once power data is flowing, the **Overview** page starts showing real data.

## Step 2: Set your capacity limit

Go to **Settings > Limits & safety** and configure:

- **Hard cap (kW)** — your hourly limit. This is the average power level you do not want to exceed within any given hour. Set this to match your grid tariff step (effekttrinn), for example 5 kW or 8 kW.
- **Safety margin (kW)** — a buffer below the hard cap. PELS starts turning things down before you actually hit the limit. A margin of 0.3-0.5 kW is a reasonable starting point.

::: tip
Enable **Simulation mode** in **Settings > Simulation mode** while you are getting started. PELS will calculate what it *would* do without actually controlling any devices. This lets you verify the setup is sensible before giving PELS real control.
:::

## Step 3: Choose which devices PELS controls

Go to **Settings > Devices**. For each device you want PELS to manage, configure:

| Control | What it means |
| --- | --- |
| **Managed** | PELS includes the device in its planning. Unmanaged devices are treated as background load. |
| **Limit** | PELS is allowed to lower or turn this device off to stay within your hard cap. |
| **Price** | PELS adjusts this device's temperature targets based on electricity prices (only relevant for temperature devices). |

Good first candidates are water heaters, floor heating, panel heaters, and ventilation — devices that use a lot of power but can tolerate being turned down for a while.

## Step 4: Set up modes, priorities, and targets

Modes are the core of how PELS decides what to do. Each mode stores a separate set of priorities and target temperatures for your devices. Go to **Settings > Modes** to configure them.

### Create your modes

Common modes are **Home**, **Night**, and **Away**. Think of them as profiles for different situations:

- **Home** — normal daytime comfort
- **Night** — keep bedrooms warm, lower priority on other heating
- **Away** — reduce everything to minimum acceptable levels

### Set priorities and target temperatures

For each device in each mode, you configure two things:

- **Priority** — a number where lower means more important. When PELS needs to turn things down, it starts with the highest-numbered (least important) devices and works its way up. When there is room again, it resumes devices in the opposite order.
- **Desired temperature** — the target temperature PELS will set for this device in this mode (for temperature devices).

For example, in **Night** mode you might set:
- Bedroom heater: priority 1, target 20 °C — stays on as long as possible
- Living room heater: priority 2, target 18 °C — turned down before the bedroom
- Water heater: priority 3 — turned off first if needed

### Switch modes with Flows

Modes only take effect when activated. Create Flows to switch modes automatically:

- **Time-based**: Set mode to Night at 23:00, Home at 07:00
- **Presence-based**: Set mode to Away when everyone leaves, Home when someone arrives
- **Manual**: Use a virtual button or the Homey app to switch modes on demand

Use the **Set operating mode** Flow action card to change the active mode.

Re-sending the current mode is also a simple way to reapply targets if a device has drifted from its target temperature.

## Step 5: Add price optimization (optional)

If you want PELS to shift heating to cheaper hours, go to **Settings > Electricity prices**:

1. Choose your price source — **Norway (spot + grid tariff)** if you are in Norway, or **Homey Energy** / **Flow tag** for other sources.
2. Make sure the price status shows that data is available.
3. If using the Norway source, select your county, grid company, and tariff group.

Then go to **Settings > Devices**, open each temperature device that should participate, and enable **Price** or **Setup > Price-based control**. Water heaters and floor heating are usually the best candidates — they have thermal mass that makes shifting worthwhile.

After at least one device has price response enabled, use **Settings > Price-aware devices** to turn **Respond to prices** on or off globally and set per-device temperature adjustments:
- **Cheap-hour boost (°C)** — temperature boost during cheap hours, for example +2 °C.
- **Expensive-hour reduction (°C)** — temperature reduction during expensive hours, for example -2 °C.

## Step 6: Add Smart tasks (optional)

Use Smart tasks when one device must reach a target by a specific time. For example:

- charge an EV to 80% by 07:00
- heat a room to 21 °C by 06:30
- heat a water heater before a busy morning

Smart tasks are created with Homey Flow action cards such as **Add charging task** and **Add heating task**. See [Smart Tasks](/smart-tasks) for the full guide.

## Quick setup checklist

Once you have worked through the steps above, verify:

1. Your power meter Flow is running and the Overview shows current usage.
2. A hard cap and safety margin are set in **Settings > Limits & safety**.
3. At least a few devices are marked as Managed and have Limit enabled.
4. You have at least one mode with sensible priorities and targets.
5. You have Flows to switch between modes.
6. Optional Smart task Flows are configured for devices that need a target by a ready-by time.
7. Simulation mode is disabled when you are ready for PELS to take real control.

## Terminology and units

- **Power** is instantaneous load, measured in **W** or **kW**.
- **Energy** is usage over time, measured in **kWh**.
- **Hard cap** — your maximum average power for any hour, in **kW**.
- **Safety margin** — a buffer below the hard cap where PELS starts reacting, in **kW**.
- **Available power** — how much more load PELS can fit right now before it reaches the current safe pace, in **kW**.
- **Daily budget** — an optional soft guide for total energy in a day, in **kWh**. This never overrides the hourly hard cap.

## What to read next

- [Configuration](/configuration) for the full settings reference
- [Flow Cards](/flow-cards) for all available Homey automation cards
- [Cost-Saving Functions](/cost-saving-functions) for choosing between power limiting, budget, price shift, tasks, and Flows
- [Smart Tasks](/smart-tasks) for charging or heating a device by a ready-by time
- [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows) for fixed cheapest-hour windows
- [PELS Insights](/insights-device) for dashboards and quick status
- [Configure an EV Charger](/ev-charger) for current-controlled EV charging
- [Tips and Best Practices](/tips-and-best-practices) for tuning advice
- [Daily Energy Budget](/daily-budget) for daily pacing and budget control
