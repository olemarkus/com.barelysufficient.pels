---
title: "Setup Guide: Connect a Meter and Start Managing a Device"
description: Connect your meter, choose one device, confirm the relevant settings, then preview and activate PELS.
---

# Getting Started

**Connect the meter → choose one device → confirm settings → preview and activate.**

## Before you begin

Install [PELS on Homey Pro](https://homey.app/a/com.barelysufficient.pels), with a whole-home meter and a suitable device available in Homey.

## Open PELS settings

Open **More → Apps → PELS → Settings**, then **Set up PELS** on Overview. You can also open **Settings > Setup & recommendations**. Use **Continue** to move through the settings that apply to your home.

## Step 1: Connect your power meter

Check the detected source and current reading. If you need to select a meter, choose **Power source > Power meter**, then **Whole-home meter**. PELS can adopt the only whole-home meter marked **Tracks total home energy consumption** in Homey, unless it has already received Flow readings.

If your source needs a Flow, use **Report power usage** with current power in watts. For solar, send net import, negative when exporting. [Meter setup details](/homey-energy).

<details>
<summary>No meter readings?</summary>

Check the selected meter in Homey and whether its reading changes. For a Fluvius P1 reader, [activate the user port through Mijn Fluvius](https://www.fluvius.be/nl/meters-en-meterstanden/maak-je-meter-slim) and check the P1 or GP indicator on the meter. Activation can take up to 72 hours.

</details>

<span id="step-3-choose-which-devices-pels-controls"></span>

## Step 2: Choose one device

Turn on **Managed by PELS** for one suitable device. For devices with power readings, this also enables **Power-limit control**. Open **Device settings** to review what PELS may change.

For solar, select **Use more of your own solar**. The action opens the appropriate existing control:

| Device control | Setting |
| --- | --- |
| Temperature adjustment | **Use solar surplus** |
| On/off operation | **Run on solar surplus** |
| EV charging with suitable control | **Charge on solar surplus** |
| Other suitable stepped loads | **Match solar surplus** |

You can find this path before export has been observed. If a prerequisite is missing, follow the hint beside the action. [Solar setup details](/solar).

A dynamic-price contract, battery, daily budget, and Smart task are not required.

<span id="step-2-set-your-limits"></span>

## Step 3: Confirm relevant settings

Review the choices PELS shows for this home:

- **Capacity limit** applies to measured hourly or 15-minute average grid import. Choose the period, hard cap, and safety margin, or turn it off if it does not apply.
  Dutch household grid charges depend on connection size, so in the Netherlands setup offers **Turn off Capacity limit** in one tap. Prices and solar keep working.
- **Grid import limit** is a separate choice for limiting current grid import. Use either limit, both, or neither.
- **Prices** appears in setup only when an enabled feature uses them.

In Flanders, use **15-minute average** if your bill uses measured quarter-hour peaks. **Use 15-minute average** changes only the period; confirm your hard cap separately. Advice can be dismissed and never changes settings automatically.

<details>
<summary>Dutch solar contracts and Flemish peak billing</summary>

Dutch net metering ends on **1 January 2027**. Export still receives compensation; the benefit of using more solar at home depends on your contract. [Dutch government guidance](https://www.rijksoverheid.nl/themas/klimaat-milieu-en-natuur/energie-thuis/salderingsregeling).

Dutch bills also use “capacity tariff” for connection-capacity charges. PELS's **Capacity limit** concerns measured average peaks. [ACM guidance](https://consument.acm.nl/elektriciteit-en-gas/wat-betaal-ik-voor-mijn-energie/wat-zijn-netwerkkosten-capaciteitstarief-aansluittarief-meettarief).

For eligible Flemish digital-meter households, the **2.5 kW billing minimum** is a billing rule, not a recommended PELS target. **Highest completed quarter this month** is based on readings received by PELS. It does not reproduce the operator's billing calculation, which applies its own minimums and aggregation. [Vlaamse Nutsregulator guidance](https://www.vlaamsenutsregulator.be/elektriciteit-en-aardgas/nettarieven/capaciteitstarief).

</details>

## Step 4: Preview and activate

Open **Review setup**. Check the selected device, enabled controls, and applicable limits.

**Simulation mode is on** means PELS is still previewing. Choose **Start managing** to enable control, or **Keep simulating** to return to Overview. The simulation banner's **Review and start** action brings you back.

A solar device showing **Waiting for solar surplus** can be correctly configured. Missing meter readings or an unavailable solar signal are separate conditions with their own checks.

Before adding a Smart task to a solar-only device, remember that the active task decides when it runs and may use grid electricity.

<span id="quick-setup-checklist"></span>

Your first setup needs a connected meter, one suitable managed device, and confirmation of the settings that apply. You can add more devices later.

## Optional next steps

<span id="step-4-set-up-modes-priorities-and-targets"></span>
<span id="create-your-modes"></span>
<span id="set-priorities-and-target-temperatures"></span>
<span id="switch-modes-with-flows"></span>

### Modes and priorities

Priorities are assigned automatically. Change them or add custom modes under **Settings > Modes** when needed. For temperature devices, review the existing target. [Configuration reference](/configuration).

<span id="step-5-add-price-optimization-optional"></span>

### Price response

Choose a source under **Settings > Electricity prices**, then enable **Price-based control** on the temperature devices that should use it. [Price-aware devices](/configuration#settings-price-aware-devices).

<span id="step-6-add-smart-tasks-optional"></span>

### Smart tasks

Open **Smart tasks > New smart task**, choose a device and goal, then preview its ready-by time. Use Flows for repeating tasks. [Smart tasks guide](/smart-tasks).

### Daily budget

Add a [daily energy budget](/daily-budget) only if you want one.

## Terminology and units

See the [Glossary](/glossary) for units and PELS terms, and [Limits & safety](/configuration) for the settings reference.

## What to read next

- [Solar and Self-Consumption](/solar)
- [Configure an EV Charger](/ev-charger)
- [How PELS Decides](/how-pels-decides)
- [Tips and Best Practices](/tips-and-best-practices)
- [Troubleshooting](/troubleshooting)
