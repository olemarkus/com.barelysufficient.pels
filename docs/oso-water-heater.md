---
title: Configure an OSO Water Heater
description: "Use an OSO water heater paired through the OSO inCharge app with PELS: setup, temperature per mode, and power limiting through the target temperature."
---

# Configure an OSO Water Heater

This page covers OSO water heaters paired through the OSO inCharge app, such as the ChargeR3. The app registers the heater as class **Other**. PELS recognises it as a water heater, so it appears under **Setup → Devices** like any other heater.

## How PELS controls it

PELS controls the heater through its **target temperature**, which the OSO app saves as the heater's temperature for every hour of the day. To limit the heater, PELS lowers that target so the element stops. To resume, PELS sets it back to the mode's target. The draw PELS plans with is the heater's own power reading.

PELS does not use the heater's on/off. In the OSO app that value shows whether the element is heating right now, and switching it sends a timed force command: off lasts one hour, and on forces heating whatever OSO's own schedule says. PELS shows the heater as heating or idle from its power reading instead.

## Set it up

1. Open the heater under **Setup → Devices** and turn on **Managed by PELS**. In **Modes**, place it low in each mode's priority order. A full tank holds its heat for hours, so a low priority makes it the first device PELS limits.
2. Under **Temperature per mode**, set the tank temperature for each mode, for example 65 °C in Home and 45 °C in Away.
3. Keep **When the temperature changes outside PELS** on **Return to mode target** or **Save as current mode target**. With **Keep the new temperature**, PELS never writes the target, and the target is the only way PELS can limit this heater.
4. Under **Power limiting**, **Limited temperature** sets the target PELS uses while it limits the heater. The element stays off while the tank is hotter than that. With no value saved, PELS uses the mode's target less 3 °C, at most 40 °C.

A smart task can have the tank hot by a set time, using the temperature the heater reports.

## What changes in the OSO app

PELS writes one temperature for all 24 hours, so a profile with different temperatures per hour in the OSO app is replaced when PELS first sets the target. Use PELS modes for temperatures that change through the day instead.

OSO's own **Force on**, **Force off** and sleep mode Flow cards still work, and so does the heater's on/off button in Homey. Turning the heater on, from the button or a Flow, forces it to heat for an hour whatever its target, and PELS cannot cancel that. While the heater is forced on, PELS limits other devices to keep the house under its limit. Turn off Flows that force the heater on once PELS manages it.

## Related Pages

- [Hot water and heating in cheap hours](/use-cases/homey-water-heater-cheap-hours)
- [Smart Tasks](/smart-tasks)
- [Configuration](/configuration)
