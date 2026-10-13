---
title: Tesla vehicle charging
description: Control Tesla charging through Tesla Car & Energy with the PELS EV charger settings.
---

# Tesla vehicle charging

PELS can manage charging through the **Battery & charging** device in **Tesla Car & Energy**. It appears as an EV charger in PELS, with charging steps, priorities and Smart tasks. Its battery level is available without a battery-reporting Flow.

## Set up the car

1. Pair the car, **Battery & charging**, and location devices through Tesla Car & Energy. They must identify the same vehicle.
2. Open the charging device in **PELS → Settings → Devices**. Follow [Configure an EV Charger](/ev-charger) to choose the correct phases and current limit for your car and installation. Current commands use whole amps from 6 to 32 A; pausing uses the charging switch.
3. In **Setup → Charging current**, enable **Control this car through Tesla** and save the choice. Manage either the car or its physical charger: turn off **Power-limit control** for the other device.
4. Create a Homey API key with **Flow** permission using [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro). Save the key, then select **Use built-in control**. PELS cannot create this key for you. One key works for all supported chargers on this Homey.

Saving a key does not change the selected method. If you already have a current-setting Flow, remove that action, select **Check again**, and explicitly choose built-in control. Keep unrelated Flows. You can replace or remove the saved key from this section.

## Use a Flow instead

Select the Flow method and use:

| Flow part | Card |
| --- | --- |
| **When** | PELS: **Stepped device target changed** for the charging device |
| **And** | PELS: **Stepped-load request is still valid**, using the **Request ID** tag |
| **Then** | Tesla Car & Energy: set charging current using the **EV charger current (A)** tag |

Put the check immediately before the current action and add no delay between them. PELS handles start and stop separately. Do not add a second current controller alongside the selected method.

## Charging at home

Control requires an online, stationary vehicle connected for AC charging at Homey's configured location. Missing or ambiguous location evidence blocks control. Moving away, disconnecting, becoming unavailable or losing the Homey device feed revokes the confirmed session. Fresh home-location evidence is required to establish it again. Keep Homey's location accurate.

Tesla commands depend on the vehicle and its connection to Tesla. PELS prepares the current limit before starting a paused car and confirms running adjustments through reported current and power. Commands may be delayed or fail, and this cannot provide fast overload protection. Avoid another service independently controlling the same charging session, including reward or charging-schedule services that compete with PELS.
