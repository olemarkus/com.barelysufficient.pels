---
title: Limit a Temperature Device Through a Virtual Thermostat
description: Give PELS a power reading for a heater or ventilation unit whose app reports none, by combining it with a smart plug or sub-meter in an Advanced Virtual Device.
---

# How-To: Limit a Temperature Device Through a Virtual Thermostat

Use this pattern when PELS should limit a device by lowering its temperature, but the device's Homey app reports no power, and a separate meter measures what it draws. A typical case is a ventilation unit with an electric air heater, plugged into a smart plug that measures power.

PELS limits a device only when it has a power reading for that device. Here the reading and the temperature setting sit on two different Homey devices. A virtual thermostat brings them together: PELS manages the virtual thermostat, and three Flows connect it to the real device and the meter.

Don't let PELS manage the smart plug itself. PELS would limit it by switching it off, which stops the whole unit, fans included.

## What You Need

- The device's Homey app, with a target temperature you can set from a Flow.
- A smart plug or sub-meter that reports the device's power in Homey.
- The [Device Capabilities](https://homey.app/a/nl.qluster-it.DeviceCapabilities) app, which makes the **Advanced Virtual Device** used below.

## 1. Create the Virtual Thermostat

The quickest way is to import the template below. It creates a virtual thermostat with three fields:

| Field | Range | What it holds |
| --- | --- | --- |
| **Target temperature** | 5 to 30 °C | The temperature PELS sets. A Flow passes it on to the real device. |
| **Temperature** | -40 to 60 °C | The real device's measured temperature. |
| **Power** | 0 to 10000 W | The meter's power reading. |

1. In Homey, add a device and choose **Device Capabilities** > **Advanced Virtual Device**.
2. Choose **Importing a TEF**, paste the template, and press **Read Device**.
3. Give the device a name, for example the name of the real unit, and finish.

```text
[tef:AVD:"H4sIAAAAAAACA4XSXWrCQBAH8KvIPCew+dDqvrWhgtDagpY+lFImyagLSTZsJiqId+oZerKS0LhYU/sUZv5D5jewB0jqinU+S3RRgTwcHdBGrVWB2SwFCeNQ+Ihi5HpCjN1wMvLcySpJ3bGfejfDGMNhGIMDFTGrYt38AZKsAgm8IZPripHBgaLOYzJPq3n7nSrK0gpkYIMFI9dVFwgbLGnPPe07rTPCoi+pmdtTLno9wxHmZPAi8OaYE0hYolkTD5jykgxybeh0i7fY6N1te2g79NE79FIobma+PiPbfFQFyKEtcQ8ysLsjQ8g0zfQuQtOw2NRk11KJBpkiLDFWmWJFv0b8Dt8D8k/qnLCqDfWy/T6237LdUNhGAx/Z+irc/x8e/MCf9Y7MaW9wQS7P8w77alstVdiygXpCCNu6ag3+th4dSGmrEuqs9w+LwVYZrjEbnD15BPn2fvwGvPJQ2V8DAAA=":/tef]
```

To set it up by hand instead, give the Advanced Virtual Device the **Thermostat** class and three number fields shown as **Target temperature**, **Measured temperature** and **Power**. On each field, turn on **Create real field and Default Flowcards**: without it, Homey does not see the field as a real temperature or power value, and PELS cannot use it. Give every field a real range, as in the table. If the values do not update after you save the fields, restart the Device Capabilities app once.

## 2. Connect It With Flows

Make three Flows:

| When | Then |
| --- | --- |
| The meter's power changes | Set the virtual thermostat's **Power** to the meter's power. |
| The real device's temperature changes | Set the virtual thermostat's **Temperature** to that temperature. |
| The virtual thermostat's **Target temperature** is set | Set the real device's target temperature to that value. |

The first two use the **Set Number** action of the Advanced Virtual Device. The third starts from its **Number set** trigger for the **Target temperature** field, which fires every time PELS changes the target.

Change the temperature in PELS from now on, not in the device's own app: the virtual thermostat does not see changes made there.

## 3. Add It to PELS

1. Open the virtual thermostat in PELS and turn on **Managed by PELS**. Leave the real device and the smart plug unmanaged.
2. Set its temperatures under **Temperature per mode**. PELS sends them through the third Flow.
3. Under **Power limiting**, set **Limited temperature** to a temperature at which the heater stays off.

PELS now sees the unit's real power. When it needs room under your limit, it lowers the target to the limited temperature, the heater switches off, and the meter's reading drops. When power allows, PELS sets the mode's temperature again.
