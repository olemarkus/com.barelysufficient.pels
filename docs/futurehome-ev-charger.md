---
title: Configure a Futurehome EV Charger
description: "Configure Futurehome Charge current control in PELS with built-in access or a Homey Flow."
---

# Configure a Futurehome EV Charger

Start with [Configure an EV Charger](/ev-charger). This page only covers what is different for the Futurehome Charge paired through the Futurehome app.

PELS starts and stops charging through the charger's own charging switch. It reads the selected current from the charger's **Current limit** setting, so you do not need a Flow that reports the current back to PELS.

That setting only follows changes made through Homey. If the current is changed in the Futurehome app or by another controller, Homey shows the new value only after the Futurehome Homey app restarts, so change the current limit through Homey.

## Choose the EV control mode

Select the EV control mode that matches how the charger is wired. When the charger's **Installed phases** setting is **One**, PELS suggests 1-phase charging. For a three-phase installation, choose the mode yourself: on a 230 V IT grid, a three-phase charger draws less power per amp than the 3-phase mode assumes.

Set the highest current PELS may use in the EV control mode, no higher than the limit set when the charger was installed. The charger will not go above that installation limit, but Homey still shows the higher value, so PELS would plan for current the charger never delivers. PELS changes the charger's **Current limit** setting as it adjusts charging, so that setting no longer holds your own maximum.

## Built-in current control

Open the charger's **Setup → Charging current** section. The Futurehome app only accepts current changes through its **Set current limit** action, so built-in control needs a Homey API key with **Flow** permission. Create one using [Homey's API-key guide](https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro), enter it here, and choose **Save key and enable**. If a key is already verified, choose **Use built-in control**. One key works for all supported chargers on this Homey.

Each command changes only this charger, so there is no installation to confirm.

Before switching from an existing Flow, remove its **Set current limit** action and choose **Check again**. Enable built-in control and check that the page says **Built-in current control is selected**. If you add a current-setting Flow later, PELS cannot stop it, and the two would override each other: the page then says **Built-in current control is paused**, PELS leaves the current to the Flow, and built-in control resumes on its own once you remove that action and choose **Check again**.

## Flow alternative

Use this Flow shape:

| Flow part | Card |
| --- | --- |
| **When** | PELS: **Stepped device target changed** for your Futurehome charger |
| **Then** | Futurehome: **Set current limit to** |

Choose **Use a Flow** in Charging current. PELS controls start and stop separately.

In the Futurehome action card, use the PELS Flow tag **EV charger current (A)** for the current value.

## Related Pages

- [Configure an EV Charger](/ev-charger)
- [Flow Cards](/flow-cards)
