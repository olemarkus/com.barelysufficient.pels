---
title: Configure an Easee EV Charger
description: "Let PELS control an Easee EV charger directly through the Easee Homey app, with no Flows for the charging current."
---

# Configure an Easee EV Charger

Start with [Configure an EV Charger](/ev-charger) for **Managed by PELS**, **Power-limit control** and priority. This page only covers what is different for Easee.

PELS sets the charging current of an Easee charger itself, through the Easee app for Homey. You do not need a Flow that sends the current to the charger, and you do not need a Flow that reports the current back to PELS.

## Before You Begin

- The Easee app is installed in Homey and your charger is paired.

## Step 1: Check the EV Control Mode

Open **More -> Apps -> PELS -> Settings -> Devices** and turn on **Managed by PELS** for the charger. If the charger has no control model yet, PELS picks **EV 1-phase** or **EV 3-phase** from how the Easee app reports the charger is wired: its phase mode, or the grid type it detected.

Open the charger and check **Control model**. PELS plans in amps for an EV charger, and the control model tells it how much power each amp is. **EV 1-phase** assumes 230 V single-phase charging; **EV 3-phase** assumes a 400 V TN supply. If the Easee app cannot tell, for example before the charger has detected its grid, confirm the supply and charging mode before choosing.

**230 V IT three-phase charging is not supported by these presets.** PELS leaves a new charger's control model unchanged when Easee reports an IT three-phase grid, unless Easee is locked to single-phase charging. This also applies when Easee is locked to three-phase charging. Do not select **EV 3-phase** as a workaround: it overestimates power on an IT grid. Existing saved models are kept, so check yours if you already use IT three-phase charging. If Easee is already configured for single-phase charging, **EV 1-phase** remains supported.

PELS picks the control model only once. If your car charges on one phase from a three-phase charger, choose **EV 1-phase** yourself, or switch between the two with the **Set EV charging phase** Flow card when you charge different cars. PELS never changes it back.

## Step 2: Check Built-in Device Control

In the charger's **Setup** section, **Use built-in device control** should be on.

PELS turns it on by itself when none of your Flows already sets the charger's current. With it on, PELS:

- sets the charger's dynamic charging current, in whole amps
- reads the current back from the charger, so it knows which level the charger actually runs at
- pauses charging by setting the current to 0 A, and resumes it by raising the current again
- starts charging again when the session was stopped outside PELS, for example in the Easee app, unless [**Leave off until turned on again**](/configuration#leave-off-until-turned-on-again) is on for the charger

Setting the current below 6 A in the Easee app, where the charger pauses, counts as turning charging off outside PELS. When PELS wants the charger running, it puts current back, unless **Leave off until turned on again** is on.

Pausing at 0 A keeps the charging session open. A charger that needs an RFID tag to charge does not ask for the tag again when PELS resumes it, and charging resumes at 6 A instead of the charger's maximum. PELS then raises the current to the planned level as power allows.

After PELS raises the current again, the Easee charger waits about 5 minutes before the car starts charging. PELS counts the charger as on during that wait and keeps its power set aside. Do not start charging in the Easee app during the wait: that starts a new charging session at the charger's maximum current.

If you turn off **Power-limit control** for the charger while PELS has it paused, PELS lets it charge again at 6 A and then stops changing the current. It stays at 6 A until the next charging session starts. Raise the current in the Easee app if you want it to charge faster.

If you turn off **Use built-in device control** while PELS has the charger paused, PELS still sets 6 A when it wants the charger running, because only a current resumes a paused session. After that, your own Flow sets the current.

PELS does not change the charger's maximum current setting in the Easee app.

### If you already have a charger Flow

If one of your Flows already sets the charger's current with the Easee card **Set dynamic charger current**, PELS leaves built-in control off and shows **The Flow "…" already controls this device** on the charger's page. Your Flow keeps working as before.

To switch to built-in control, disable or delete the part of that Flow that sets the current. PELS picks that up within 30 minutes and turns built-in control on. You can also turn **Use built-in device control** on yourself right away.

A Flow that only reports the car's battery level to PELS is not a current-control conflict. Keep it if you use Flow battery reporting and have no car selected in the charger's **Car** section. If you select a car there, PELS ignores the battery-reporting Flow.

## Charging Session Starts

An Easee charger goes back to its maximum current whenever a charging session starts: when the car is plugged in, or when PELS starts a session that was stopped outside PELS. Pausing and resuming does not start a new session. PELS sees that on the charger and sets the planned current again after the next whole-home power reading. With a Homey Energy power source that reading normally arrives within 10 seconds. With a Flow power source, the timing follows your **Report power usage** Flow. Until that reading arrives, the car can draw more than PELS planned.

## Battery Reporting

Choose a supported car in the charger's **Car** section to use its battery level when PELS matches it to the charger. Alternatively, leave the car selection empty and use **Report battery level for charger**, selecting the Easee charger in that Flow card. These are separate battery sources: while any car is selected, PELS ignores both Flow reports and the charger's own battery reading, including while waiting to match a car. See [EV charger battery reporting](/ev-charger#step-5-configure-boost-mode-battery-reporting).

## Troubleshooting

| Problem | What to check |
| --- | --- |
| **Use built-in device control** is not shown | Check that **Control model** is **EV 1-phase** or **EV 3-phase**, and that the charger is paired with the Easee app. |
| Built-in control stays off | Look for the Flow notice on the charger's page, and disable the part of that Flow that sets the charger current. |
| The charger uses more or less power per step than PELS expects | Check that the control model matches the charger's phases. |
| Charging does not start right after PELS resumes it | Easee waits about 5 minutes after the current is raised. Leave it: starting charging in the Easee app opens a new session at the charger's maximum current. |

## Related Pages

- [Configure an EV Charger](/ev-charger)
- [Deadline Charging With State of Charge](/how-to-deadline-charging-soc)
- [Flow Cards](/flow-cards)
