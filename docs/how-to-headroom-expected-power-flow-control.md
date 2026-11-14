---
title: Wire a Flow-Based Load Device
description: Use PELS stepped-load profiles and generic Flow cards to connect a device with its own power levels that PELS cannot control directly.
---

# How-To: Wire a Flow-Based Load Device to PELS

Use this pattern when a real Homey device has its own stepped power modes, but PELS should still decide which step to use, and PELS cannot set those modes itself.

Check the device's page in PELS first. Many devices need none of these Flows: PELS sets the level of a Høiax Connected water heater, a supported EV charger, and any device whose Homey app lets Homey set its power directly. Such a device shows **Use built-in device control** under **Setup**, or a **Control model** of **Automatic**. Build the Flows below only when neither is offered.

Typical devices:

- water heaters with `Low/Medium/Max` whose app offers only Flow action cards for them
- EV chargers PELS cannot control directly (see [Configure an EV Charger](/ev-charger#charging-current-setup))
- other controllable loads with discrete states

PELS owns the decision, and your Homey Flows only do the vendor-specific mapping.

## What You Are Building

Two Flow paths:

1. **Outbound desired-step mapping**
When PELS changes the desired stepped-load level, your Flow maps that generic intent to the vendor action card.

2. **Inbound step feedback**
When the device changes level, your Flow reports the selected step back into PELS.

This keeps three values separate:

- **selected step** on the device
- **measured power** right now
- **planning power** that PELS reserves for that step

## Why This Works

For stepped-load devices, `measure_power` is not enough to know the selected level:

- the heater may be set to `Max` while drawing `0 W`
- the live draw may be lower than the configured step
- the vendor app may report step changes separately from power

That is why PELS needs explicit step feedback from your Flows.

## Example Mapping (a 3 kW water heater)

| Step | Planning Power | Vendor Action |
|------|----------------|---------------|
| Off | 0 W | Set power level to Off |
| Low | 1250 W | Set power level to Low |
| Medium | 1750 W | Set power level to Medium |
| Max | 3000 W | Set power level to Max |

The vendor action names here stand for whatever the heater's app offers.

- The outbound Flow reacts to **Stepped device target changed** for the heater.
- Each branch checks the **Planning power (W)** token and calls the matching vendor action.
- The feedback Flow listens for the device's own level or power change and reports the matching stepped-load level back into PELS.

If your device app exposes a direct level trigger, prefer reporting the step directly with **Report stepped load for [device] as [step]**. If it only exposes a power value, use **Report stepped load for [device] matching [power]**.

## Setup Checklist

1. In the PELS device settings, set `Control model` to `Stepped load`.
2. Define the device steps and planning power values.
3. Under **Power limiting**, choose how far **What PELS does when limiting this device** may go:
   `Turn off` (as far as off) or `Set to step` (as far as the lowest active step).
   PELS goes only as deep as it needs, so a stepped device will often be left
   running at a lower step either way.
4. Create the outbound Flow from **Stepped device target changed** for [device] to the vendor action cards.
5. Create the inbound feedback Flow with either:
   **Report stepped load for [device] as [step]**
   or
   **Report stepped load for [device] matching [power]**

## Common Pitfalls

- Forgetting the feedback Flow. Without it, PELS only knows what it last asked for. When the device reports no level back for two level changes in a row, the device card says **Level change not confirmed** and points you to the Flow that reports the level back.
- Treating `measure_power = 0` as if the selected step were `Off`.
- Mapping vendor power feedback to the wrong configured planning power.
- Using **Set expected power for device** for a stepped-load device. That card is legacy and is rejected for built-in stepped loads.

## PELS Cards Used

- **Stepped device target changed** for [device]
- **Report stepped load for [device] as [step]**
- **Report stepped load for [device] matching [power]**
