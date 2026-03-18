---
title: Tips and Best Practices
description: Practical advice for priorities, capacity tuning, price optimization, and basic troubleshooting in PELS.
---

# Tips and Best Practices

This page is for the tuning phase after your first working setup.

## Start small

Do not hand the entire house to PELS on day one.

- Start with a few flexible loads
- Confirm that power reporting is stable
- Watch the Overview tab during a real high-load hour

Once the behavior matches your expectations, expand the managed device set.

## Priority advice

- **Water heaters** are often good low-priority candidates because they store heat.
- **Living-room thermostats** are usually high priority because comfort loss is obvious.
- **Bedroom heating** is often higher priority at night than during the day.
- Different modes should use different priority orders if comfort changes by time of day.

## Capacity tuning advice

- Set the limit slightly below the actual grid limit if you want extra safety.
- Start with a larger soft margin, such as `0.5` to `1.0 kW`, then tighten later if PELS is too conservative.
- Use **Dry run** first if you want to observe planner decisions without touching real devices.

## Price optimization advice

- Thermal loads are usually the best targets.
- Start with modest deltas such as `+3` and `-3 C`.
- Set a minimum price difference so comfort is not traded away for tiny savings.

## Daily budget advice

- Treat daily budget as pacing, not as an emergency brake.
- Leave the advanced tuning values at their defaults unless you have observed a real problem you are trying to solve.
- Change one value at a time and observe a full day before making another adjustment.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No power samples received | Make sure a Flow calls **Report power usage** whenever your meter updates. |
| Devices do not appear | Confirm they expose supported capabilities and device classes. |
| PELS is not controlling devices | Verify **Managed by PELS** is on, **Capacity-based control** is enabled, and **Dry run** is off. |
| Expected power looks wrong | Check the device Energy settings in Homey or set a more accurate load in the device settings. |
| No price data | Confirm the configured source is correct and external Flow payloads contain full-day JSON. |

## When to dive deeper

- Use [Daily Energy Budget](/daily-budget) if you want to understand whole-day pacing.
- Use [Technical Reference](/technical) if you want exact planner rules.
- Use [Plan States](/plan-states) when the Overview tab wording needs interpretation.
