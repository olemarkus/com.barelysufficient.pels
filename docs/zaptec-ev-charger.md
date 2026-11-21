---
title: Configure a Zaptec EV Charger
description: "Let PELS control a Zaptec EV charger directly through the Zaptec Homey app."
---

# Configure a Zaptec EV Charger

Start with [Configure an EV Charger](/ev-charger). This page only covers what is different for Zaptec.

Zaptec exposes the selected charger current to Homey, so PELS can read the current step automatically. You do not need the generic selected-current feedback Flow for Zaptec.

## Automatic charging power

A Zaptec app version that lets Homey set the charger's charging power offers **Automatic** under **Control model**, and a newly managed charger uses it. PELS then sets the charging power directly in the power levels the charger publishes, and the Zaptec app handles phases and the installation current. No key, Flow or EV phase model is needed, and the current setup below is not used. A charger PELS set up before keeps its manual setup until you choose **Automatic**.

The Zaptec app applies that power to the whole installation, so PELS uses it only for a charger with no other Zaptec charger on its installation.

While PELS controls the charger, it keeps the charger's power control in Homey set to **Homey**. If you change it to **Automatic** in the Zaptec device, PELS sets it back.

## Built-in current control

Without **Automatic**, PELS sets charging current through the Zaptec app's writable current capability. No API key is needed. Open the charger's **Setup → Charging current** section. For an installation with one charger, confirm **This installation has only one charger**, then choose **Use built-in control**.

If the installed Zaptec app does not expose writable current control, update it or use a current-setting Flow. An existing Flow keeps working until you explicitly switch methods. With built-in control selected and no Flow, PELS limits the charger by pausing and resuming charging until the app is updated, and the charger's card on Overview shows a warning.

Before switching from an existing Flow, remove its current-setting action and choose **Check again**. Enable built-in control and check that the page says **Built-in current control is selected**. If you add a current-setting Flow later, PELS cannot stop it, and the two would override each other: the page then says **Built-in current control is paused**, PELS leaves the current to the Flow, and built-in control resumes on its own once you remove that action and choose **Check again**. Keep unrelated battery-level Flows.

Zaptec's current control changes the current for the whole installation. PELS refuses built-in current control when it knows of another charger on that installation. Only confirm a single-charger installation when that is true; otherwise keep your existing coordinated installation Flow.

## Several chargers on one installation

Zaptec's current setting applies to the whole installation, so PELS does not set it when the installation has more than one charger. Keep the Flow that coordinates those chargers: **Setup → Charging current** then offers **Use a Flow**. PELS still starts and stops each charger.

## Battery Reporting

The Zaptec charger does not know the car's battery level. Select the car in the charger's **Car** section, or, with no car selected, report it with **Report battery level for charger** and choose the Zaptec charger in that card. See [EV charger battery reporting](/ev-charger#step-4-configure-boost-mode-battery-reporting).

## Related Pages

- [Configure an EV Charger](/ev-charger)
- [Flow Cards](/flow-cards)
