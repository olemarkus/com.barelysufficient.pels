# Daily Energy Budget

The Daily Energy Budget is a soft kWh/day guide. It does not override the hourly capacity system. Instead, it produces a **daily usage based cap** for the current hour, and the planner uses the smaller of that and the **capacity based cap**.

This feature always uses the whole-home meter data that PELS already collects (the same stats used for hourly and daily usage).

## Terminology

- **Capacity based cap**: the hourly soft limit derived from your grid tariff limit (e.g., 5/10/15 kW) and margin.
- **Daily usage based cap**: a soft hourly cap derived from the daily plan (history + price shaping).

## What It Does

- Builds a plan for how much energy should be used across the current local day.
- Tracks how much energy has been used since local midnight.
- Computes how much is "allowed by now" based on the plan.
- Computes a daily usage based cap for the current hour from the plan.
- Freezes the plan for the rest of the day if the budget is overspent. If the day is underspent, the plan can still rebalance.
- Uses the smaller of the capacity based cap and the daily usage based cap.

## How the cap is applied

PELS always computes the capacity based cap for the current hour. When daily budget is enabled, it also computes a daily usage based cap for the same hour. The planner then uses the smaller of those two caps when deciding shedding and restores.

## Examples (Scenarios)

### 1) Over plan, daily cap becomes the limiter
It’s 15:00. The plan says you should have used 35 kWh by now, but you have used 40 kWh.
The daily usage based cap for this hour becomes lower than the capacity based cap. The planner uses the smaller cap, which reduces headroom. As a result, some restores won’t happen and low-priority devices can be shed earlier.

### 2) Behind plan, capacity cap stays in charge
It’s 10:00. The plan says 18 kWh by now, but you have used 12 kWh.
The daily usage based cap becomes higher than the capacity based cap, so the capacity cap remains the limiter. Restores and boosts are still allowed if there is headroom.

### 3) Overspent early hour, plan freezes until you catch up
At 08:00 the plan allowed 6 kWh, but you already used 7.5 kWh.
The daily budget "freezes" the plan while you are over plan. Once usage drops back under plan, it can rebalance again.

### 4) Price shaping enabled
You enable price shaping and prices are cheap from 01:00–05:00 and expensive in the evening.
The daily plan shifts more of the remaining allowance to cheap hours, which raises the daily usage based cap overnight and lowers it during expensive hours.

### 5) Daily budget off
Daily budget disabled means PELS uses only the capacity based cap and price optimization (if enabled). There is no daily pacing.

## Settings

- **Enable daily energy budget**: turns the feature on/off.
- **Daily budget (kWh)**: target daily energy use. Range: 20–360 kWh.
- **Aggressiveness**: controls how quickly the pressure indicator reacts to deviations (status signal).
- **Price-shape today plan**: when price optimization is enabled, the plan is weighted toward cheaper remaining hours.
- **Reset learning**: clears the learned usage profile for future plans.

## Today Plan View

The settings UI shows a "Today plan" chart and live stats:

- **Used**: kWh used so far today (local time).
- **Allowed now**: cumulative kWh that the plan allows up to the current hour.
- **Remaining**: daily budget minus used (can be negative).
- **Deviation**: used minus allowed so far (positive means over plan).
- **Pressure**: 0–100% indicator of how far over/under plan you are (status signal).
- **Confidence**: how much learned history is influencing the plan.
- **Price shaping**: shows whether price shaping is active.
- **Plan frozen**: appears while you're over plan; it clears once you are back under plan.

The chart shows planned kWh/hour as bars, with actual kWh/hour as dots for completed hours.

### Buckets and DST

Buckets are computed from local midnight to the next local midnight. On DST transitions, the number of buckets can be 23 or 25, and hour labels may repeat on fall-back days.

## How the Plan Works (High Level)

- **Default profile**: a safe baseline distribution across the day.
- **Learned profile**: updated at the end of each day from actual usage.
- **Confidence blending**: ramps from default to learned over time.
- **Price shaping** (optional): reweights remaining buckets based on today’s prices.

The plan is a cumulative curve. The current bucket's planned kWh is turned into a daily usage based cap for that hour, and the planner uses the smaller of the two caps.

## Interaction With Other Features

- **Hourly capacity limit**: always enforced. Daily budget never bypasses it.
- **Daily usage cap**: combined with the capacity based cap by taking the smaller limit.
- **Price optimization**: can reshape the plan if price shaping is enabled.

## Insights

These are exposed on the PELS Insights device:

- `daily_budget_used_kwh`
- `daily_budget_allowed_kwh_now`
- `daily_budget_remaining_kwh`
- `daily_budget_pressure`
- `daily_budget_exceeded`
- `pels_limit_reason` (indicates whether limits are due to hourly or daily budget)
