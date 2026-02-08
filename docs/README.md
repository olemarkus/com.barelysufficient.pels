# PELS - User Guide

**PELS** (Pris- og Effektstyrt Energilagringssystem) is a Homey app that helps you optimize energy usage in your home. It manages when your largest energy consumers run, keeping you within power limits and taking advantage of cheaper electricity prices (Norway pricing, Homey Energy prices, or flow tag pricing from external providers).

For the short Homey App Store description, see `README.txt` in the repository root.

Inspired by the Sparegris (Piggy Bank) Homey app.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [How to Use (Scenarios)](#how-to-use-scenarios)
- [Configuration](#configuration)
  - [Devices Tab](#devices-tab)
  - [Modes Tab](#modes-tab)
  - [Overview Tab](#overview-tab)
  - [Budget Tab](#budget-tab)
  - [Daily Budget (Budget Tab)](#daily-budget-budget-tab)
  - [Usage Tab](#usage-tab)
  - [Price Tab](#price-tab)
  - [Advanced Tab](#advanced-tab)
- [Flow Cards](#flow-cards)
  - [Triggers](#triggers)
  - [Conditions](#conditions)
  - [Actions](#actions)
- [PELS Insights Device](#pels-insights-device)
- [How It Works](#how-it-works)
- [Tips & Best Practices](#tips--best-practices)

---

## Features

- **Capacity Management** – Stay within your power limits by automatically shedding load from lower-priority devices when consumption approaches your limit
- **Price Optimization** – Adjust device temperatures based on hourly prices (boost during cheap hours, reduce during expensive hours)
- **Multiple Modes** – Define different modes (Home, Away, Night, etc.) with their own temperature targets and device priorities
- **Smart Load Shedding** – Intelligently selects which devices to turn off based on priority, and can swap lower-priority devices for higher-priority ones
- **Automatic Recovery** – Restores devices when headroom becomes available
- **Norwegian Grid Tariffs** – Fetches grid tariff energy components (nettleie) from NVE
- **Spot Prices (Norway)** – Integrates with hvakosterstrommen.no for spot prices (spotpris)
- **Homey Energy Prices** – Can use dynamic electricity prices from Homey Energy directly
- **Flow Tag Prices** – Accepts hourly price data from Power by the Hour (or any flow tag source) when you want to supply external prices
- **Price Breakdown** – Adds consumption tax (elavgift), Enova fee (enovaavgift), VAT (mva), and either electricity support (strømstøtte) or Norgespris adjustment to the hourly total (Norway only)

---

## Installation

PELS is not yet published to the Homey App Store, so you need to install it via the command line.

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started/homey-cli) installed globally:
  ```bash
  npm install -g homey
  ```
- A Homey Pro (local installation only)

### Installation Steps

```bash
# Clone the repository
git clone https://github.com/olemarkus/com.barelysufficient.pels.git
cd com.barelysufficient.pels

# Install dependencies
npm install

# Build the settings script
npm run build:settings

# Log in to your Homey (first time only)
homey login

# Install the app on your Homey
npm run install
```

> **Note:** The app runs locally on your Homey Pro. After installation, you can access the settings through the Homey app under **Apps** → **PELS** → **Settings**.

---

## Getting Started

After installation:

1. Open the Homey app
2. Go to **Apps** → **PELS** → **Settings**
3. Configure your devices, modes, and capacity settings

### Quick Setup

1. **Set your capacity limit** in the Budget tab
2. **Mark devices as managed** in the Devices tab and enable **Capacity-based control** where you want shedding
3. **Set priorities and temperatures** for each mode in the Modes tab (managed devices only)
4. **Configure price settings** (optional) in the Price tab
5. **Create a Flow** to report power usage to PELS

---

## How to Use (Scenarios)

### 1) Send power readings (required)
- Create a Flow that calls **Report power usage** whenever your meter updates (e.g., Tibber Pulse).  
- Without this, PELS cannot calculate headroom or plan shedding.

### 2) Check if you can increase a capacity-controlled load (EV charger, water heater)
- Create a Flow condition using **Is there headroom for device?**
  - Device: pick the capacity-controlled device (e.g., charger)
  - Required kW: how much extra you want to draw
- The card checks current headroom plus the device’s **expected** draw (settings.load first, then latest reading or override) with a conservative **1 kW fallback** when unknown. This avoids over-promising capacity.

### 3) Temporarily override expected power for a device
- Use the **Set expected power for device** action to set a temporary expected draw (W).  
- This is useful when a device under-reports for a short period. It expires when the device reports a new meter reading and fails if `settings.load` is set.

### 4) Switch modes automatically
- Use **Set operating mode** in Flows triggered by time/presence.  
- Different modes can set different priorities and temperatures (e.g., Night vs. Home).

### 5) Use price optimization
- Enable price optimization per device in the Devices tab, set cheap/expensive deltas, and configure your price source (Norway or flow tag) in the Price tab.

### 6) Reapply mode targets to fix drift
- If a device has drifted from its mode target (e.g., manual override), trigger **Set operating mode** with the *current* mode (and ensure dry-run is off).  
- The card will re-send the configured targets for that mode to bring devices back in line.

---

## Configuration

### Devices Tab

The Devices tab shows temperature and on/off devices that PELS can detect. Devices without power capability (no `measure_power`, no `meter_power`, and no configured load) are listed for visibility but are locked and unmanaged.

| Setting | Description |
|---------|-------------|
| **Managed by PELS** | Toggle whether PELS should include the device in modes and price optimization. Unmanaged devices are treated as uncontrolled load and hidden from the Overview plan. Requires power capability. |
| **Capacity-based control** | Toggle whether PELS can shed/restore this device for capacity. You can keep this off while still using price optimization. Requires power capability. |
| **Price Optimization** | Enable temperature adjustments based on electricity prices (managed devices only). Requires power capability. |
| **When shedding** | Choose what happens during capacity shedding: turn off (default) or drop to a minimum temperature. |

> **Note:** Only managed devices appear in the Modes tab and Price optimization list.

### Modes Tab

Modes let you define different configurations for different situations (e.g., Home, Away, Night, Vacation).

#### Active Mode
Select which mode is currently active. This determines which priorities and temperatures are used.

#### Editing Modes
- **Add mode**: Enter a name and click "Add"
- **Delete mode**: Select a mode and click "Delete"
- **Rename mode**: Select a mode and click "Rename"

#### Per-Mode Settings
For each managed device in a mode:

| Setting | Description |
|---------|-------------|
| **Desired °C** | The target temperature for this device in this mode |
| **Priority** | Lower number = higher priority (kept on longer, restored first). Drag to reorder. |

> **Tip:** Changes save automatically when you modify them.

### Overview Tab

Shows the current plan – what PELS intends to do with each device based on current power consumption and settings.
Only managed devices are listed; unmanaged load still contributes to the totals.

| Field | Description |
|-------|-------------|
| **Device** | The device name |
| **Temperature** | Current temperature and target (if available) |
| **Power** | Current → planned power state (on/off) |
| **State** | Active, Restoring, Shed, or Capacity control off |
| **Usage** | Current measured power vs. expected power (fallback 1 kW if unknown) |
| **Status** | The reason for the current plan (or "Waiting for headroom") |

Click **Refresh plan** to recalculate.

### Budget Tab

Configure capacity management and the daily budget.

#### Capacity Settings

| Setting | Description |
|---------|-------------|
| **Capacity limit (kW)** | Your maximum power draw (typically your grid connection limit). This is a **hard limit** – exceeding it for the hour triggers penalties (effekttariff). |
| **Soft margin (kW)** | Buffer zone before the hard limit. PELS starts shedding when you exceed (limit - margin), giving time to react before hitting the hard cap. The "capacity shortfall" alarm only triggers when load exceeds the hard limit itself AND cannot be reduced further. |
| **Dry run** | When enabled, PELS calculates what it would do but doesn't actually control devices. Great for testing! |

> **Important:** The hourly capacity limit is the only "panic now" limit. PELS starts shedding when you exceed (limit - margin), giving you time to react. The "capacity shortfall" alarm only triggers when load exceeds the hard limit itself AND cannot be reduced further – this is the emergency scenario requiring manual intervention.

### Daily Budget (Budget Tab)

The Daily Budget is a **soft constraint** – a kWh/day guide that creates a daily usage cap. The planner uses the smaller of the daily budget soft limit and the capacity hard limit.

**Unlike the hourly capacity limit**, violating the daily budget will never trigger emergency alarms or "manual action needed" flows. PELS will shed devices to try to stay within the daily budget, but if that's not possible, it simply continues operating without panic.

For details on how the plan is built, how DST is handled, and what each value means, see `docs/daily_budget.md`.

### Usage Tab

View power usage history and patterns.

#### Usage Summary
Shows energy consumption for today, the past week, and the past month.

#### Usage Patterns
Displays a heatmap showing your average power usage by hour of day and day of week, helping you identify consumption patterns.

#### Hourly Totals
Shows power consumption per hour for the last 30 days, derived from reported power samples. Older data is automatically aggregated into daily summaries.

> **Important:** You must create a Flow to report power usage to PELS (see [Flow Cards](#flow-cards)).

### Price Tab

Configure electricity price sources and price-based optimization.

#### Price Source

| Setting | Description |
|---------|-------------|
| **Price source** | Choose **Norway (spot + grid tariff)**, **Homey Energy**, or **Flow tag (Power by the Hour/other providers)**. Homey/Flow prices are used as provided (currency/tax unknown), and are useful when you prefer external feeds or non-Norway markets. |

#### Grid Tariff Settings (Nettleie)

| Setting | Description |
|---------|-------------|
| **County (Fylke)** | Your Norwegian county |
| **Grid company** | Your local grid company (nettselskap) |
| **Tariff group** | Husholdning (household) or Hytter (cabin) |

> These settings are only used with the Norway price source.

#### Norway Price Settings

| Setting | Description |
|---------|-------------|
| **Norway pricing model** | Choose **Strømstøtte** (threshold support model) or **Norgespris** (official fixed spot component target with tariff-group monthly cap) |
| **Price area** | Your electricity price zone (NO1-NO5). Used only for Norway pricing. |
| **Provider surcharge** | Your provider's markup on spot price (øre/kWh, incl. VAT) |
| **Price threshold (%)** | Hours below/above this % from average are marked cheap/expensive (default: 25%) |
| **Minimum price difference** | Skip optimization if savings are less than this (price units). Avoids discomfort for minimal savings. |

#### Flow Tag Setup (Power by the Hour or similar)

1. Set **Price source** to **Flow tag (Power by the Hour)**.
2. Create a Flow triggered by your price source (e.g., **Power by the Hour → Price changed**) and add the action **PELS → Set external prices (today)**. Use the tag that contains the full-day JSON payload (single quotes are accepted).
3. Create a second Flow for **PELS → Set external prices (tomorrow)** using the tag with tomorrow’s prices (if available).
4. If one flow doesn’t run, PELS will still use whichever price data is available.

PBTH (Power by the Hour) tips:
- Use the PBTH flow tags that provide the full-day JSON payload (often labeled "prices json" or similar) for today and tomorrow.
- Example payload: `{"0":0.2747,"1":0.2678,"2":0.261,"3":0.255}` (single quotes are accepted).
- Make sure the flow action input uses the full JSON string, not a single-hour value.

> **Note:** Flow tag prices are used as provided. PELS does not add VAT or change currency. This makes it suitable for regions outside Norway as well.

#### Price Calculation

For the Norway price source, the hourly total starts from:

- Spot price (spotpris)
- Grid tariff energy component (nettleie)
- Provider surcharge (incl. VAT in settings; converted to ex VAT internally)
- Consumption tax (elavgift)
- Enova fee (enovaavgift)
- VAT (mva) when applicable
- Electricity support (strømstøtte) or Norgespris adjustment (depending on Norway pricing model)

All component rates are treated as ex VAT, and VAT is applied once after summing the components.

Norway pricing models:

- **Strømstøtte**: Uses a 77 øre/kWh (ex VAT, 96.25 incl. VAT) threshold with 90% coverage above the threshold.
- **Norgespris**: Replaces strømstøtte with a `Norgespris adjustment` line that adjusts the spot component toward the official target price (40 øre/kWh ex. VAT, i.e. 50 øre/kWh incl. VAT in VAT areas).

Norgespris cap behavior:

- Monthly cap applies per calendar month.
- Cap is derived from tariff group: **Husholdning** = 5000 kWh/month, **Hytter og fritidshus** = 1000 kWh/month.
- Cap usage is consumed in chronological order for the current/future hours in the loaded price window.
- If the cap is partly remaining for an hour, the adjustment is partial for that hour.
- Above cap, the app uses non-support behavior (no strømstøtte and no Norgespris adjustment).

Regional rules:

- VAT is exempt in price area NO4.
- Reduced consumption tax applies to Troms and Finnmark counties (fylker). Municipality-level exceptions are ignored.

The Price tab tooltips show the full breakdown per hour.

Homey Energy and Flow tag pricing skip the Norway calculation and use the provided values directly.

#### Price Optimization

For each device with price optimization enabled:

| Setting | Description |
|---------|-------------|
| **Cheap Δ** | Temperature adjustment during cheap hours (e.g., +5°C) |
| **Expensive Δ** | Temperature adjustment during expensive hours (e.g., -3°C) |

> **Example:** If your Away mode sets a water heater to 60°C, a Cheap Δ of +10 will boost it to 70°C during cheap hours.

### Advanced Tab

Diagnostics and debug toggles.

| Setting | Description |
|---------|-------------|
| **Debug logging topics** | Select which areas emit debug logs. Selections persist across restarts. |

---

## Flow Cards

### Triggers

| Card | Description |
|------|-------------|
| **Capacity guard: manual action needed** | Fires when PELS cannot reduce load enough to stay within your **hourly capacity limit** – manual intervention required. This is an emergency situation indicating you're about to exceed your grid capacity for the hour. **Note:** This only triggers for hourly hard cap violations (effekttariff), never for daily budget violations (which are soft constraints). The PELS Insights device will also show a "Capacity shortfall" alarm. |
| **Operating mode changed to...** | Fires when the operating mode switches to the selected mode |
| **Price level changed to...** | Fires when the price level changes (Cheap/Normal/Expensive/Unknown) |

### Conditions

| Card | Description |
|------|-------------|
| **Is there enough capacity?** | Check if there's capacity for a specified kW load |
| **Is there headroom for device?** | Check if the current headroom plus the device's estimated draw can accommodate an extra kW amount (useful for EV chargers, water heaters, etc.) |
| **Operating mode is...** | Check which mode is currently active |
| **Price level is...** | Check the current price level (Cheap/Normal/Expensive/Unknown) |

### Actions

| Card | Description |
|------|-------------|
| **Report power usage** | **Required!** Feed current power draw (W) from your power meter to PELS |
| **Set capacity limit** | Change the capacity limit dynamically |
| **Set operating mode** | Switch between modes (Home, Away, etc.) |
| **Set expected power for device** | Provide an explicit expected draw (W) when the device can’t report it (e.g., map “Power changed to Max” → 3000 W). Fails if the device already has a configured load. |
| **Enable capacity control for device** | Turn on capacity-based control for a single device |
| **Disable capacity control for device** | Turn off capacity-based control for a single device |
| **Set external prices (today)** | Store today’s hourly prices from a flow tag (Power by the Hour) |
| **Set external prices (tomorrow)** | Store tomorrow’s hourly prices from a flow tag (Power by the Hour) |

---

## PELS Insights Device

PELS includes a virtual device called "PELS Insights" that displays the currently active mode and capacity shortfall status.

### Adding PELS Insights

1. Go to **Devices** → **Add Device**
2. Select **PELS** → **PELS Insights**
3. Add the device

The device shows:
- **Current mode name** – Updates automatically when you change modes
- **Capacity shortfall alarm** – Activates when PELS cannot reduce load enough to stay within your hourly capacity limit and manual action is needed. This only triggers for hourly hard cap violations, not daily budget violations.

---

## How It Works

### Capacity Management

1. **Monitor**: PELS receives power readings via the "Report power usage" Flow action
2. **Calculate**: It compares current usage against your soft limit (limit - margin)
3. **Plan**: When over the soft limit, it creates a plan to shed devices, starting with the lowest priority (highest number)
4. **Execute**: Unless in dry-run mode, it turns off devices according to the plan
5. **Recover**: When power drops and headroom is available, it restores devices in priority order

### Priority-Based Shedding

- Devices with **higher priority numbers** are shed first
- Devices with **lower priority numbers** are kept on longest and restored first (priority 1 is most important)
- PELS can "swap" – turn off multiple low-priority devices to restore a single high-priority device

### Price Optimization

For the Norway price source:
1. Fetches spot prices from hvakosterstrommen.no
2. Fetches grid tariffs from NVE
3. Calculates total cost per hour (spot + grid tariff + provider surcharge (incl. VAT) + consumption tax (elavgift) + Enova fee (enovaavgift) + VAT (mva) and then either strømstøtte or Norgespris adjustment)
4. Marks hours as "cheap" or "expensive" based on your threshold
5. Applies temperature deltas to devices during those hours

For the Homey Energy and Flow tag price sources:
- Uses hourly prices supplied by Homey/flows and treats values as provided.

> **Want more detail?** See the [Technical Documentation](technical.md) for in-depth information about the capacity budget model, cooldown logic, priority swapping, and system assumptions.

---

## Tips & Best Practices

### Setting Priorities

- **Water heaters**: Often good candidates for low priority (can store heat)
- **Living room thermostats**: Usually high priority (comfort)
- **Bedroom heating**: High priority at night, lower during day
- Use different priorities in different modes (e.g., bedroom high priority in Night mode)

### Capacity Settings

- Set your limit slightly below your actual grid limit for safety
- Start with a higher margin (0.5-1 kW) and reduce if PELS sheds too aggressively
- Use **dry run mode** first to see what PELS would do without affecting your devices

### Price Optimization

- Water heaters are ideal for price optimization (high thermal capacity)
- Start with modest deltas (+3/−3°C) and adjust based on experience
- Set a minimum price difference to avoid frequent changes for tiny savings

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "No power samples received" | Create a Flow to report power usage |
| Devices not appearing | Make sure they have temperature or on/off capabilities and a supported class |
| No price data | Configure price area and/or grid company |
| PELS not controlling devices | Check "Managed by PELS" and "Capacity-based control" are enabled (and "Dry run" is disabled) |

---

## Support

- **Issues**: Report bugs on the GitHub repository
- **Author**: Ole Markus With (olemarkus@gmail.com)
