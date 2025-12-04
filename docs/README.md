# PELS - User Guide

**PELS** (Pris- og Effektstyrt Energilagringssystem) is a Homey app that helps you optimize energy usage in your home. It manages when your largest energy consumers run, keeping you within power limits and taking advantage of cheaper electricity prices.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
  - [Devices Tab](#devices-tab)
  - [Modes Tab](#modes-tab)
  - [Power Usage Tab](#power-usage-tab)
  - [Plan Tab](#plan-tab)
  - [Price Tab](#price-tab)
- [Flow Cards](#flow-cards)
  - [Triggers](#triggers)
  - [Conditions](#conditions)
  - [Actions](#actions)
- [Mode Indicator Device](#mode-indicator-device)
- [How It Works](#how-it-works)
- [Tips & Best Practices](#tips--best-practices)

---

## Features

- **Capacity Management** – Stay within your power limits by automatically shedding load from lower-priority devices when consumption approaches your limit
- **Price Optimization** – Adjust device temperatures based on electricity prices (boost during cheap hours, reduce during expensive hours)
- **Multiple Modes** – Define different modes (Home, Away, Night, etc.) with their own temperature targets and device priorities
- **Smart Load Shedding** – Intelligently selects which devices to turn off based on priority, and can swap lower-priority devices for higher-priority ones
- **Automatic Recovery** – Restores devices when headroom becomes available
- **Norwegian Grid Tariffs** – Fetches real-time grid tariffs (nettleie) from NVE
- **Spot Prices** – Integrates with hvakosterstrommen.no for electricity spot prices

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

1. **Set your capacity limit** in the Power Usage tab
2. **Mark devices as controllable** in the Devices tab
3. **Set priorities and temperatures** for each mode in the Modes tab
4. **Configure price settings** (optional) in the Price tab
5. **Create a Flow** to report power usage to PELS

---

## Configuration

### Devices Tab

The Devices tab shows all devices in your home that have temperature control capabilities (thermostats, water heaters, etc.).

| Setting | Description |
|---------|-------------|
| **Controllable** | Toggle whether PELS can control this device. Only controllable devices will be managed for capacity and price optimization. |
| **Price Optimization** | Enable temperature adjustments based on electricity prices. |

> **Note:** You must enable "Controllable" for a device before it appears in the Modes tab.

### Modes Tab

Modes let you define different configurations for different situations (e.g., Home, Away, Night, Vacation).

#### Active Mode
Select which mode is currently active. This determines which priorities and temperatures are used.

#### Editing Modes
- **Add mode**: Enter a name and click "Add"
- **Delete mode**: Select a mode and click "Delete"
- **Rename mode**: Select a mode and click "Rename"

#### Per-Mode Settings
For each controllable device in a mode:

| Setting | Description |
|---------|-------------|
| **Desired °C** | The target temperature for this device in this mode |
| **Priority** | Higher number = higher priority (kept on longer). Drag to reorder. |

> **Tip:** Changes save automatically when you modify them.

### Power Usage Tab

Configure capacity management and view power consumption.

#### Capacity Settings

| Setting | Description |
|---------|-------------|
| **Capacity limit (kW)** | Your maximum power draw (typically your grid connection limit) |
| **Soft margin (kW)** | Buffer zone before the hard limit. PELS starts shedding when you exceed (limit - margin) |
| **Dry run** | When enabled, PELS calculates what it would do but doesn't actually control devices. Great for testing! |

#### Usage Summary
Shows energy consumption for today, the past week, and the past month.

#### Usage Patterns
Displays a heatmap showing your average power usage by hour of day and day of week, helping you identify consumption patterns.

#### Hourly Totals
Shows power consumption per hour for the last 30 days, derived from reported power samples. Older data is automatically aggregated into daily summaries.

> **Important:** You must create a Flow to report power usage to PELS (see [Flow Cards](#flow-cards)).

### Plan Tab

Shows the current plan – what PELS intends to do with each device based on current power consumption and settings.

| Column | Description |
|--------|-------------|
| **Device** | The device name |
| **Current** | Current state (on/off and temperature) |
| **Planned** | What PELS plans to do (keep, shed, restore) |

Click **Refresh plan** to recalculate.

### Price Tab

Configure electricity price sources and price-based optimization.

#### Grid Tariff Settings (Nettleie)

| Setting | Description |
|---------|-------------|
| **County (Fylke)** | Your Norwegian county |
| **Grid company** | Your local grid company (nettselskap) |
| **Tariff group** | Husholdning (household) or Hytter (cabin) |

#### Spot Price Settings

| Setting | Description |
|---------|-------------|
| **Price area** | Your electricity price zone (NO1-NO5) |
| **Provider surcharge** | Your provider's markup on spot price (øre/kWh) |
| **Price threshold (%)** | Hours below/above this % from average are marked cheap/expensive (default: 25%) |
| **Minimum price difference** | Skip optimization if savings are less than this (øre/kWh). Avoids discomfort for minimal savings. |

#### Price Optimization

For each device with price optimization enabled:

| Setting | Description |
|---------|-------------|
| **Cheap Δ** | Temperature adjustment during cheap hours (e.g., +5°C) |
| **Expensive Δ** | Temperature adjustment during expensive hours (e.g., -3°C) |

> **Example:** If your Away mode sets a water heater to 60°C, a Cheap Δ of +10 will boost it to 70°C during cheap hours.

---

## Flow Cards

### Triggers

| Card | Description |
|------|-------------|
| **Capacity guard: manual action needed** | Fires when PELS cannot reduce load enough – manual intervention required. The mode indicator device will also show a "Capacity shortfall" alarm. |

### Conditions

| Card | Description |
|------|-------------|
| **Is there enough capacity?** | Check if there's capacity for a specified kW load |
| **Capacity headroom band** | Check if headroom is High, Medium, or Low |
| **Capacity mode is...** | Check which mode is currently active |

### Actions

| Card | Description |
|------|-------------|
| **Report power usage** | **Required!** Feed current power draw (W) from your power meter to PELS |
| **Set capacity limit** | Change the capacity limit dynamically |
| **Set capacity mode** | Switch between modes (Home, Away, etc.) |

### Essential Flow: Reporting Power Usage

PELS needs to know your current power consumption. Create this Flow:

**Trigger:** When power meter reports new value  
**Action:** PELS → Report power usage → `{{power in watts}}`

Example using a Tibber Pulse:
```
WHEN Tibber Pulse power changed
THEN Report power usage: {{Power}}
```

---

## Mode Indicator Device

PELS includes a virtual device called "Capacity mode" that displays the currently active mode and capacity shortfall status.

### Adding the Mode Indicator

1. Go to **Devices** → **Add Device**
2. Select **PELS** → **Capacity mode**
3. Add the device

The device shows:
- **Current mode name** – Updates automatically when you change modes
- **Capacity shortfall alarm** – Activates when PELS cannot reduce load enough and manual action is needed

---

## How It Works

### Capacity Management

1. **Monitor**: PELS receives power readings via the "Report power usage" Flow action
2. **Calculate**: It compares current usage against your soft limit (limit - margin)
3. **Plan**: When over the soft limit, it creates a plan to shed devices, starting with lowest priority
4. **Execute**: Unless in dry-run mode, it turns off devices according to the plan
5. **Recover**: When power drops and headroom is available, it restores devices in priority order

### Priority-Based Shedding

- Devices with **lower priority numbers** are shed first
- Devices with **higher priority numbers** are kept on longest
- PELS can "swap" – turn off multiple low-priority devices to restore a single high-priority device

### Price Optimization

1. Fetches spot prices from hvakosterstrommen.no
2. Fetches grid tariffs from NVE
3. Calculates total cost per hour (spot + nettleie + provider surcharge)
4. Marks hours as "cheap" or "expensive" based on your threshold
5. Applies temperature deltas to devices during those hours

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
| Devices not appearing | Make sure they have temperature capabilities |
| No price data | Configure price area and/or grid company |
| PELS not controlling devices | Check "Controllable" is enabled and "Dry run" is disabled |

---

## Support

- **Issues**: Report bugs on the GitHub repository
- **Author**: Ole Markus With (olemarkus@gmail.com)
