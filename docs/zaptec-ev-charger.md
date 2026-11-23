---
title: Configure a Zaptec EV Charger
description: "Let PELS control a Zaptec EV charger directly through the Zaptec Homey app."
---

# Configure a Zaptec EV Charger

Start with [Configure an EV Charger](/ev-charger). This page only covers what is different for Zaptec.

Zaptec exposes the selected charger current to Homey, so PELS can read the current step automatically. You do not need the generic selected-current feedback Flow for Zaptec.

## Automatic charging power

A Zaptec app version that lets Homey set the charger's charging power offers **Automatic** under **Control model**, and a newly managed charger uses it. PELS then sets the charging power directly in the power levels the charger publishes, and the Zaptec app handles phases and the installation current. No key, Flow or EV phase model is needed, and the current setup below is not used. A charger PELS set up before keeps its manual setup until you choose **Automatic**.

The Zaptec app applies that power to the whole installation. While PELS sets its charging power, it keeps the charger's power control set to **Homey**. If you change it to **Automatic** in the Zaptec device, PELS sets it back.

## Built-in current control

Without **Automatic**, PELS sets charging current through the Zaptec app's writable current capability. No API key is needed. Open the charger's **Setup → Charging current** section. For an installation with one charger, confirm **This installation has only one charger**, then choose **Use built-in control**.

If the installed Zaptec app does not expose writable current control, update it or use a current-setting Flow. An existing Flow keeps working until you explicitly switch methods. With built-in control selected and no Flow, PELS limits the charger by pausing and resuming charging until the app is updated, and the charger's card on Overview shows a warning.

Before switching from an existing Flow, remove its current-setting action and choose **Check again**. Enable built-in control and check that the page says **Built-in current control is selected**. If you add a current-setting Flow later, PELS cannot stop it, and the two would override each other: the page then says **Built-in current control is paused**, PELS leaves the current to the Flow, and built-in control resumes on its own once you remove that action and choose **Check again**. Keep unrelated battery-level Flows.

## Several chargers on one installation

Turn on **Managed by PELS** and **Power-limit control** for every charger in the installation. Under **Setup → Charging current**, each charger shows which one PELS uses to set the available current. Zaptec shares that current between the cars that are charging. PELS lowers the available current when it needs to limit charging and pauses the cars if the lowest level still uses too much power.

The chargers share a priority. Moving one in **Modes** moves the other chargers on its installation. Each charger keeps its own switch and car settings. A charger you leave off stays off when charging resumes elsewhere on the installation. A battery-level smart task stops only its own charger when its car reaches the target.

PELS uses one charging-current range for the shared assignment. It takes the highest minimum and lowest maximum of the cars that may charge, using each charger's default range when its car has none. A paused car still counts so it can resume safely. A car that has finished or unplugged releases its range. Charging waits if no supported current fits every range. Zaptec decides how much current each car gets within the assignment.

A battery-level task's extra permissions can protect the shared current. Only the power used by a charger with a budget exemption is counted as exempt.

If a charger is unmanaged, has **Power-limit control** off, is in another meter area, or PELS lacks a working shared-current route, keep the Flow that coordinates the installation's current. PELS still starts and stops managed chargers individually when it has permission to control them.

## Battery Reporting

The Zaptec charger does not know the car's battery level. Select the car in the charger's **Car** section, or, with no car selected, report it with **Report battery level for charger** and choose the Zaptec charger in that card. See [EV charger battery reporting](/ev-charger#step-4-configure-boost-mode-battery-reporting).

## Related Pages

- [Configure an EV Charger](/ev-charger)
- [Flow Cards](/flow-cards)
