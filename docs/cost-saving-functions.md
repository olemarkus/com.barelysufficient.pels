---
title: Cost-Saving Functions
description: Compare power limiting, daily budget, price-based temperature shift, and Smart tasks so you can choose the right PELS feature.
---

# Cost-Saving Functions

PELS has several ways to reduce electricity cost. They are related, but they solve different problems.

Use this page when you are deciding whether to rely on power limiting, daily budget, price-based temperature shift, Smart tasks, or a Flow-based cheapest-hour setup.

## Quick Comparison

| Function | Best for | What PELS changes | Main constraint |
| --- | --- | --- | --- |
| **Power limiting** | Staying below a grid tariff step or breaker limit | Pauses, lowers, or resumes managed devices when the home gets close to the hard cap | Hourly hard cap |
| **Daily budget** | Shaping total whole-home energy through the day | Gives more room to cheap or useful hours and less room to expensive hours | Daily kWh budget plus hourly hard cap |
| **Price-based temperature shift** | Moving heating or cooling on devices with thermal mass | Raises targets in cheap hours and lowers targets in expensive hours | Temperature comfort range |
| **Smart tasks** | Getting a specific device ready by a time | Plans the cheapest useful hours before the ready-by time | Target, ready-by time, prices, budget, and hard cap |
| **Flow-booked hours** | Custom "run for X cheap hours before Y" automation | Your Flow enables power-limit control only during selected hours | Your Flow logic plus hard cap |

![PELS overview showing live power, safe pace, and managed devices](/screenshots/landing-overview.png)
*Figure 1. The Overview shows current power, safe pace, and which managed devices are running or limited.*

## Power Limiting

Power limiting is the core safety feature. PELS watches whole-home power and limits lower-priority devices before the current hour is likely to exceed your configured hard cap.

Use it when:

- You want to stay inside a capacity tariff step.
- You have large devices that can pause briefly.
- You want PELS to decide which devices make room for higher-priority devices.

Typical devices:

- water heater
- panel heater or floor heating
- ventilation
- EV charger with current control

Power limiting does not try to find the cheapest hours by itself. It mainly answers: "Can this device run right now without pushing the home over the hard cap?"

## Daily Budget

Daily budget is a whole-home pacing layer. It spreads a daily kWh budget across the day and can use prices to give more room to cheaper hours.

Use it when:

- You want the whole home to use less energy across the day.
- You want cheap hours to get more of the day's available energy.
- You do not care which device uses a cheap hour, as long as total usage shifts.

This is useful when a water heater, room heating, or an EV charger may all take advantage of the same cheap window. Daily budget does not reserve cheap hours for a specific device. It creates a better whole-home pace.

## Price-Based Temperature Shift

Price-based temperature shift is per-device temperature behavior. PELS can raise the target temperature in cheap hours and lower it in expensive hours.

Use it when:

- The device has thermal mass.
- Comfort can drift a little without becoming a problem.
- You want a simple setup without a ready-by time.

Good candidates are floor heating, water heaters, and rooms that stay warm for a while after heating stops. Poor candidates are rooms where the temperature must be exact at a specific time.

![PELS price settings showing the selected price source](/screenshots/landing-price.png)
*Figure 2. Price settings supply the cheap and expensive hour information used by price shift, daily budget, Smart tasks, and price-based Flows.*

## Smart Tasks

Smart tasks are for devices that need to reach a target before a specific time. PELS plans useful hours before the ready-by time, using prices and the device's learned or configured behavior.

Use them when:

- A car should reach a target battery level by morning.
- A water heater or room should be ready before a known time.
- You want the selected device, not just any household load, to use the best hours.

Smart tasks still work with the rest of PELS. The hard cap still matters, priority still matters, and budget can still reduce how aggressively the task runs unless the feature explicitly says otherwise.

Mode targets, boost settings, and Smart task targets can be different on purpose. See [Different Targets Can Be Useful](/smart-tasks#different-targets-can-be-useful).

See [Smart Tasks](/smart-tasks) for the full guide.

## Flow-Booked Hours

Flow-booked hours are useful when you want a simple "run for X cheap hours before Y" rule instead of a target-based task.

The pattern is:

1. Keep the device managed by PELS.
2. Turn **Power-limit control** off by default, so PELS does not start it just because there is available power.
3. Use the **Current price is one of the lowest before a time** card to pick the cheapest hours in a window.
4. Enable **Power-limit control** during those hours.
5. Disable **Power-limit control** outside those hours.

This lets your Flow choose the time window while PELS still protects the hard cap during the hours when the device is allowed to run.

See [Book Cheap Hours With Flows](/how-to-book-cheap-hours-with-flows).

## Which One Should I Use?

Start with power limiting. It protects the hourly limit and gives the rest of the setup a safe base.

Add daily budget if you want whole-home pacing across the day.

Add price-based temperature shift for thermal devices that can preheat or coast through expensive hours.

Add Smart tasks when one specific device must be ready by a specific time.

Use Flow-booked hours when you want a fixed number of cheap hours and prefer to own the scheduling logic in Homey Flows.
