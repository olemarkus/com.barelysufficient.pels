---
title: Daily Energy Budget
description: How PELS paces whole-day energy use without turning daily misses into emergency alarms.
---

# Daily Energy Budget

The Daily Energy Budget is a target for total kWh in one day. You set, for example, "I want the house to use no more than 50 kWh today." PELS spreads that target across the hours of the day and gently slows things down if you are getting ahead of plan.

It is a **soft target**, not a hard limit. If the house ends up over budget, nothing dramatic happens — PELS keeps running, devices keep heating, and you do not get an emergency notification. The only thing that ever triggers an urgent alert is your **hourly hard cap** (your grid tariff step or breaker limit). The daily budget is for shaping the day, not protecting the grid connection.

PELS reads your existing whole-home power meter to track today's usage — the same data you already see in the Usage tab. You do not need to set up anything extra.

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

- **Daily pace** — how fast PELS thinks the house should be using power right now to land on the daily target. If you are ahead of plan, the daily pace is lower; if you are behind, it is higher.
- **Effective pace** — PELS protects the hard cap and the daily target at the same time. Whichever is stricter at the moment is the one currently in effect.
- **Allowed by now** — how much of the day's budget should have been used by this hour according to the plan.
- **Remaining** — daily budget minus what has been used so far today. Can be negative if you have already gone over.

## What It Does

- Builds a plan for how much energy should be used across the current local day.
- Tracks how much energy has been used since local midnight.
- Computes how much is "allowed by now" based on the plan.
- Computes a daily pace for the current hour from the plan.
- Freezes the plan for the rest of the day if the budget is overspent. If the day is underspent, the plan can still rebalance.
- Uses the tighter of the hourly pace and the daily pace.

## How the Daily Pace is Applied

PELS is always watching two things at once: how close the current hour is to the hard cap, and how close the day is to the daily target. Whichever needs more care right now is the one driving decisions.

If you are well under the daily target, only the hard cap matters and the day just runs normally. If you are running ahead of the daily target, PELS becomes a bit more conservative: it may keep a heater paused a little longer, or hold off on resuming a water heater until the next hour.

The daily pace can never raise the hourly hard cap. Your grid tariff step is sacred. The daily target only ever makes PELS more cautious, never less.

End-of-hour rules that protect the hard cap from a last-minute burst do not apply to the daily target. Going slightly over a daily target at 23:55 is not a problem — there is no penalty.

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

The same advanced tuning controls also appear under **Settings > Advanced > Daily budget tuning**:

- **Background usage reserve**: how much daily budget PELS holds back for household usage it cannot move, such as appliances, lights, and unmanaged devices. `Balanced` uses the normal reserve. `Conservative` reserves more, which can reduce daily-budget misses but leaves less budget for managed devices.
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
