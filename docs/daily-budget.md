---
title: Daily Energy Budget
description: How PELS paces whole-day energy use without turning daily misses into emergency alarms.
---

# Daily Energy Budget

The Daily Energy Budget is a **soft constraint** - a kWh/day guide that helps pace your energy use. It does not override the hourly capacity system. Instead, it produces a daily pace for the current hour, and the planner uses the tighter of that pace and the hourly capacity pace.

**Key distinction:** Unlike the hourly capacity limit (hard cap), the daily budget will never trigger emergency alarms or manual-action Flows. If PELS cannot limit enough devices to meet the daily budget, it simply continues operating. Only projected breaches of the hourly hard-cap budget trigger urgent intervention.

This feature always uses the whole-home meter data that PELS already collects (the same stats used for hourly and daily usage).

## Budget-Exempt Devices

Budget exemption is a control rule, not a meter rewrite:

- Exempt devices are ignored by daily budget control.
- Their real usage still counts in `used`, `remaining`, `deviation`, and budget overrun reporting.
- They are treated as background usage when PELS builds and learns the daily budget plan.
- They still count toward hourly capacity protection, including hard-cap and safety-margin limiting.

This means a budget-exempt device can leave the household over the daily budget without causing other devices to be limited just to compensate for that exempt load.

## Terminology

Shared capacity terminology and units are defined in:

- [Getting Started: Terminology and Units](getting-started.md#terminology-and-units)

Daily-budget-specific terms:

- **Daily pace**: A planning pace derived from the daily plan (history + price shaping). Never triggers urgent manual-action Flows.
- **Effective pace**: The tighter of the hourly pace and daily pace - this is what the planner uses for limiting decisions.
- **Allowed by now**: Planned cumulative kWh at the current local-hour bucket.
- **Remaining**: `daily_budget_kWh - used_today_kWh` (kWh, can be negative).

## What It Does

- Builds a plan for how much energy should be used across the current local day.
- Tracks how much energy has been used since local midnight.
- Computes how much is "allowed by now" based on the plan.
- Computes a daily pace for the current hour from the plan.
- Freezes the plan for the rest of the day if the budget is overspent. If the day is underspent, the plan can still rebalance.
- Uses the tighter of the hourly pace and the daily pace.

## How the Daily Pace is Applied

PELS always computes the hourly pace for the current hour. When daily budget is enabled, it also computes a daily pace for the same hour. The planner then uses the tighter of those two when deciding whether devices should be limited or resumed.

The daily pace is capped at the hourly hard cap before the safety margin. This ensures the daily budget never allows more power than your grid connection supports.

**Important:** End-of-hour capping, which prevents bursting at the end of an hour, only applies to the hourly capacity pace, not the daily budget pace. Daily budget misses are not time-critical in the same way - there is no grid penalty for exceeding a daily budget at 11:55.

## Examples (Scenarios)

### 1) Over plan, daily pace becomes the tighter limit
It's 15:00. The plan says you should have used 35 kWh by now, but you have used 40 kWh.
The daily pace for this hour becomes lower than the hourly capacity pace. That reduces available power. As a result, some devices will not resume yet and low-priority devices can be limited earlier.

### 2) Behind plan, hourly capacity stays in charge
It's 10:00. The plan says 18 kWh by now, but you have used 12 kWh.
The daily pace becomes higher than the hourly capacity pace, so hourly capacity remains the tighter limit. Resumes and boosts are still allowed if there is available power.

### 3) Overspent early hour, plan freezes until you catch up
At 08:00 the plan allowed 6 kWh, but you already used 7.5 kWh.
The daily budget "freezes" the plan while you are over plan. Once usage drops back under plan, it can rebalance again.

### 4) Price shaping enabled
You enable price shaping and prices are cheap from 01:00–05:00 and expensive in the evening.
The daily plan shifts more of the remaining allowance to cheap hours, which raises the daily pace overnight and lowers it during expensive hours.

### 5) Daily budget off
Daily budget disabled means PELS uses only hourly capacity and price optimization, if enabled. There is no daily pacing.

## Where To Configure It

The main daily budget surface is the **Budget** page.

The page has two local views:

| View | What it does |
| --- | --- |
| **Plan** | Shows the selected day's progress, hourly plan, confidence, and current status. |
| **Adjust** | Lets you preview and apply daily-budget changes before they become active. |

The **Adjust** view includes:

- **Enable daily budget**: turns the feature on/off.
- **Daily budget (kWh)**: target daily energy use. Range: 20-360 kWh.
- **Use cheaper hours**: when price optimization is enabled and prices are reliable, the plan is weighted toward cheaper remaining hours.
- **Background usage reserve**: how much daily budget PELS holds back for household usage it cannot move, such as appliances, lights, and unmanaged devices.
- **Managed device flexibility**: how freely PELS may shift managed-device usage toward cheaper hours after preserving minimum service.

Use **Preview changes** before applying. PELS shows the candidate plan so you can compare it with the current plan.

### Advanced Tuning

The same advanced tuning controls also appear under **Settings > Advanced > Daily budget tuning**. The Advanced page still uses the older label **Unmanaged usage reserve** for the same background usage reserve:

- **Unmanaged usage reserve**: current Advanced label for background usage reserve. It controls how much daily budget PELS holds back for household usage it cannot move, such as appliances, lights, and unmanaged devices. `Balanced` uses the normal reserve. `Conservative` reserves more, which can reduce daily-budget misses but leaves less budget for managed devices.
- **Managed device flexibility**: how freely PELS may shift managed-device usage toward cheaper hours after preserving minimum service. `Low` stays close to normal managed-device usage, `Medium` shifts some usage, and `High` shifts more aggressively toward cheaper feasible hours.
- **Show daily budget breakdown in the chart**: stacks background usage and managed device usage in the chart.

**Warning:** these controls can significantly change pacing behavior and when devices are limited or resumed. Keep defaults unless you are deliberately tuning behavior. If you change them, adjust one parameter at a time and observe at least a full day.

For exact formulas and worked examples, see [Daily Budget Weighting Math (Advanced)](daily-budget-weights.md).

## Plan View

The **Plan** view shows a selected-day chart and live stats:

- **Used**: kWh used so far today (local time).
- **Allowed now** or **Budget this hour**: cumulative or hourly kWh that the plan allows up to the current hour.
- **Remaining**: daily budget minus used (can be negative).
- **Deviation**: used minus allowed so far (positive means over plan).
- **Plan confidence**: backtested forecast-skill score - how regular the home's hourly usage is, and how well it follows shifted budget plans when managed load exists.
- **Use cheaper hours**: shows whether price-aware shaping is active.
- **Plan frozen**: appears while budget-managed load is over plan; exempt devices can leave reporting over plan without freezing the daily plan.

The chart can show **Progress** or **Hourly plan**. Progress focuses on whether the selected day is on track. Hourly plan shows the planned kWh per hour, with actual kWh for completed hours when available.

### Buckets and DST

Buckets are computed from local midnight to the next local midnight. On DST transitions, the number of buckets can be 23 or 25, and hour labels may repeat on fall-back days.

## How the Plan Works (High Level)

- **Default profile**: a safe baseline distribution across the day.
- **Learned profile**: updated at the end of each day from actual usage.
- **Profile blending**: ramps from default to learned over time (internal, not shown in UI).
- **Price shaping** (optional): shifts remaining allowance between the effective floor and cap based on today's prices.

The plan is a cumulative curve. The current bucket's planned kWh is turned into a daily pace for that hour, and the planner uses the tighter of the hourly capacity pace and daily pace.

## Interaction With Other Features

- **Hourly capacity limit (hard cap)**: Always enforced. Daily budget never bypasses it. Only projected breaches of this hourly hard-cap budget trigger urgent manual-action Flows.
- **Daily pace**: Combined with the hourly pace by taking the tighter limit. Never triggers emergency alarms.
- **Budget-exempt devices**: Skipped by daily-budget control, but still visible in real usage and still managed by hourly capacity protection.
- **Price optimization**: Can reshape the daily plan if price shaping is enabled.
- **Smart tasks**: Still respect the hard cap. Daily budget can make a task more conservative when the day is already over plan.

## Insights

These are exposed on the PELS Insights device:

- `pels_hourly_limit_kw` (the current effective hourly limit in kW)
- `pels_daily_budget_remaining_kwh`
- `pels_daily_budget_exceeded`
- `pels_limit_reason` (indicates whether limits are due to hourly or daily budget)
