---
title: Configure a Zaptec EV Charger
description: "Configure Zaptec charging-current control in PELS with built-in access or a Homey Flow."
---

# Configure a Zaptec EV Charger

Start with [Configure an EV Charger](/ev-charger). This page only covers what is different for Zaptec.

Zaptec exposes the selected charger current to Homey, so PELS can read the current step automatically. You do not need the generic selected-current feedback Flow for Zaptec.

## Built-in current control

Open the charger's **Setup → Charging current** section. For an installation with one charger, confirm **This installation has only one charger**. PELS uses a writable current capability when the installed Zaptec app exposes one. Otherwise, create a Homey API key with **Flow** permission using [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro), save it here, then choose **Use built-in control**. One key works for all supported chargers on this Homey.

Saving a key does not switch an existing Flow. Remove its current-setting action, choose **Check again**, and explicitly select built-in control. Keep unrelated battery-level Flows. If you prefer a Flow, use the alternative below.

Zaptec's action changes the current for the whole installation. PELS refuses built-in current control when it knows of another charger on that installation. Only confirm a single-charger installation when that is true; otherwise keep your existing coordinated installation Flow.

![Zaptec EV charger Flow example](images/howto_zaptec_ev_charger_flow_example.png)
*Figure 1. Example Zaptec wiring: PELS emits the desired charger current, and the car battery level is reported back to PELS.*

## Flow alternative

Use this Flow shape:

| Flow part | Card |
| --- | --- |
| **When** | PELS: **Stepped device target changed** for your Zaptec charger |
| **And** | PELS: **Stepped-load request is still valid**, with the trigger’s **Request ID** tag |
| **Then** | Zaptec: **Set available current to** |

Choose **Use a Flow** in Charging current. Place the validity check immediately before the current action, without a delay between them. PELS controls start and stop separately.

In the Zaptec action card, use the PELS Flow tag **EV charger current (A)** for the available-current value.

PELS handles the 1-phase or 3-phase conversion based on the EV control mode selected in PELS. Do not use **Planning power (W)** for the Zaptec current field unless you are intentionally building a manual conversion Flow.

## Battery Reporting

The generic EV charger guide covers battery reporting. For Zaptec, choose the same Zaptec charger in **Report battery level for charger** as you use in the current-control Flow.

That adds battery reporting to PELS, which can be used by EV boost mode.

## Related Pages

- [Configure an EV Charger](/ev-charger)
- [Flow Cards](/flow-cards)
