---
title: Getting Started
description: Install PELS on Homey Pro, connect your power meter, set a capacity limit, and get your first useful setup running.
---

# Getting Started

PELS is a Homey app that intelligently manages your heavy electrical loads. It keeps your power usage within your hourly limit, decides which devices to turn down first, and can shift heating to cheaper hours — all automatically.

In practice, most users spend their time in **Apps -> PELS -> Settings** and a small number of Homey Flows.

If PELS is not installed yet, get it from the [Homey App Store](https://homey.app/a/com.barelysufficient.pels).

## Before you begin

- PELS must already be installed on your Homey Pro.
- You need a power meter or another Flow source that can report current load in watts (e.g. Tibber Pulse, a HAN port reader, or Homey Energy).
- You should know which devices in your home use the most power and can tolerate being turned down temporarily.

## Open PELS settings

Open **Apps -> PELS -> Settings** in Homey. This is where all configuration happens.

## Step 1: Connect your power meter

Without live power input, PELS cannot know how much power your home is using.

Create a Homey Flow that calls **Report power usage** whenever your meter updates. This is typically a single Flow with your power meter as the trigger and the PELS action card as the action.

Common meter sources are Tibber Pulse, AMS/HAN readers, or any device that reports total household watts.

Once this Flow is running, the Overview tab starts showing real data.

## Step 2: Set your capacity limit

Go to the **Budget** tab and configure:

- **Capacity limit (kW)** — your hourly hard cap. This is the average power level you do not want to exceed within any given hour. Set this to match your grid tariff step (effekttrinn), for example 5 kW or 8 kW.
- **Soft margin (kW)** — a buffer below the hard cap. PELS starts turning things down before you actually hit the limit. A margin of 0.3–0.5 kW is a reasonable starting point.

::: tip
Enable **Dry run** in the Devices tab while you are getting started. PELS will calculate what it *would* do without actually controlling any devices. This lets you verify the setup is sensible before giving PELS real control.
:::

## Step 3: Choose which devices PELS controls

Go to the **Devices** tab. For each device you want PELS to manage, configure:

| Checkbox | What it means |
| --- | --- |
| **Managed** | PELS includes the device in its planning. Unmanaged devices are treated as background load. |
| **CAP** (Capacity) | PELS is allowed to turn this device down or off to stay within your capacity limit. |
| **PRICE** | PELS adjusts this device's temperature targets based on electricity prices (only relevant for temperature devices). |

Good first candidates are water heaters, floor heating, panel heaters, and ventilation — devices that use a lot of power but can tolerate being turned down for a while.

## Step 4: Set up modes, priorities, and targets

Modes are the core of how PELS decides what to do. Each mode stores a separate set of priorities and target temperatures for your devices. Go to the **Modes** tab to configure them.

### Create your modes

Common modes are **Home**, **Night**, and **Away**. Think of them as profiles for different situations:

- **Home** — normal daytime comfort
- **Night** — keep bedrooms warm, lower priority on other heating
- **Away** — reduce everything to minimum acceptable levels

### Set priorities and target temperatures

For each device in each mode, you configure two things:

- **Priority** — a number where lower means more important. When PELS needs to turn things down, it starts with the highest-numbered (least important) devices and works its way up. When there is room again, it restores in the opposite order.
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

If you want PELS to shift heating to cheaper hours, go to the **Price** tab:

1. Enable **Price-based optimization**.
2. Choose your price source — **Norway (spot + grid tariff)** if you are in Norway, or **Homey Energy** / **Flow tag** for other sources.
3. If using the Norway source, select your county, grid company, and tariff group.

Then go back to the **Devices** tab and tick the **PRICE** checkbox for devices that should participate in price optimization. Water heaters and floor heating are usually the best candidates — they have thermal mass that makes shifting worthwhile.

In the Price tab you can also set per-device temperature adjustments:
- **Cheap delta** — temperature boost during cheap hours (e.g. +2 °C)
- **Expensive delta** — temperature reduction during expensive hours (e.g. -2 °C)

## Quick setup checklist

Once you have worked through the steps above, verify:

1. Your power meter Flow is running and the Overview shows current usage.
2. A capacity limit and soft margin are set in the Budget tab.
3. At least a few devices are marked as Managed and have Capacity enabled.
4. You have at least one mode with sensible priorities and targets.
5. You have Flows to switch between modes.
6. Dry run is disabled when you are ready for PELS to take real control.

## Terminology and units

- **Power** is instantaneous load, measured in **W** or **kW**.
- **Energy** is usage over time, measured in **kWh**.
- **Capacity limit (hard cap)** — your maximum average power for any hour, in **kW**.
- **Soft margin** — a buffer below the hard cap where PELS starts reacting, in **kW**.
- **Headroom** — how much room you have before hitting the soft limit: `soft_limit - current_load`, in **kW**.
- **Daily budget** — an optional soft guide for total energy in a day, in **kWh**. This never overrides the hourly hard cap.

## What to read next

- [Configuration](/configuration) for the full settings reference
- [Flow Cards](/flow-cards) for all available Homey automation cards
- [PELS Insights](/insights-device) for dashboards and quick status
- [Tips and Best Practices](/tips-and-best-practices) for tuning advice
- [Daily Energy Budget](/daily-budget) for daily pacing and budget control
