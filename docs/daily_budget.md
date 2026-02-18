# Daily Energy Budget

The Daily Energy Budget is a **soft constraint** – a kWh/day guide that helps pace your energy use. It does not override the hourly capacity system. Instead, it produces a **daily soft limit** for the current hour, and the planner uses the smaller of that and the **hourly capacity soft limit**.

**Key distinction:** Unlike the hourly capacity limit (hard cap), the daily budget will never trigger emergency alarms or "shortfall" flows. If PELS cannot shed enough devices to meet the daily budget, it simply continues operating without panic. Only projected breaches of the hourly hard-cap budget trigger emergency intervention.

This feature always uses the whole-home meter data that PELS already collects (the same stats used for hourly and daily usage).

## Terminology

- **Hourly hard cap**: Your contracted grid capacity limit (e.g., 5/10/15 kW). This equals the hourly hard-cap energy budget of `limitKw` kWh/h and is the only "panic" limit.
- **Hourly soft limit**: A dynamic run-rate limit derived from the hourly soft budget `(limitKw - marginKw)` and time remaining. PELS starts shedding when power exceeds this.
- **Daily soft limit**: A soft limit derived from the daily plan (history + price shaping). Never triggers panic/shortfall.
- **Effective soft limit**: The smaller of the hourly soft limit and daily soft limit – this is what the planner uses for shedding decisions.

## What It Does

- Builds a plan for how much energy should be used across the current local day.
- Tracks how much energy has been used since local midnight.
- Computes how much is "allowed by now" based on the plan.
- Computes a daily soft limit for the current hour from the plan.
- Freezes the plan for the rest of the day if the budget is overspent. If the day is underspent, the plan can still rebalance.
- Uses the smaller of the hourly soft limit and the daily soft limit (effective soft limit).

## How the Soft Limit is Applied

PELS always computes the hourly soft limit for the current hour. When daily budget is enabled, it also computes a daily soft limit for the same hour. The planner then uses the smaller of those two (the effective soft limit) when deciding shedding and restores.

The daily soft limit is capped at the hourly hard cap (before margin). This ensures the daily budget never allows more power than your grid connection supports.

**Important:** End-of-hour capping (which prevents bursting at the end of an hour) only applies to the hourly soft limit, not the daily soft limit. Daily budget violations are not time-critical in the same way – there's no penalty for exceeding a daily budget at 11:55.

## Examples (Scenarios)

### 1) Over plan, daily soft limit becomes the limiter
It's 15:00. The plan says you should have used 35 kWh by now, but you have used 40 kWh.
The daily soft limit for this hour becomes lower than the hourly soft limit. The planner uses the effective soft limit (the smaller of the two), which reduces headroom. As a result, some restores won't happen and low-priority devices can be shed earlier.

### 2) Behind plan, hourly soft limit stays in charge
It's 10:00. The plan says 18 kWh by now, but you have used 12 kWh.
The daily soft limit becomes higher than the hourly soft limit, so the hourly soft limit remains the limiter. Restores and boosts are still allowed if there is headroom.

### 3) Overspent early hour, plan freezes until you catch up
At 08:00 the plan allowed 6 kWh, but you already used 7.5 kWh.
The daily budget "freezes" the plan while you are over plan. Once usage drops back under plan, it can rebalance again.

### 4) Price shaping enabled
You enable price shaping and prices are cheap from 01:00–05:00 and expensive in the evening.
The daily plan shifts more of the remaining allowance to cheap hours, which raises the daily soft limit overnight and lowers it during expensive hours.

### 5) Daily budget off
Daily budget disabled means PELS uses only the hourly soft limit and price optimization (if enabled). There is no daily pacing.

## Settings

The daily budget controls live in the **Budget** tab.

- **Enable daily energy budget**: turns the feature on/off.
- **Daily budget (kWh)**: target daily energy use. Range: 20–360 kWh.
- **Price-shape today plan**: when price optimization is enabled, the plan is weighted toward cheaper remaining hours.
- **Reset learning**: clears the learned usage profile for future plans.

## Today Plan View

The Budget tab shows a "Today plan" chart and live stats:

- **Used**: kWh used so far today (local time).
- **Allowed now**: cumulative kWh that the plan allows up to the current hour.
- **Remaining**: daily budget minus used (can be negative).
- **Deviation**: used minus allowed so far (positive means over plan).
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
- **Price shaping** (optional): reweights remaining buckets based on today's prices.

The plan is a cumulative curve. The current bucket's planned kWh is turned into a daily soft limit for that hour, and the planner uses the effective soft limit (smaller of hourly and daily).

## Interaction With Other Features

- **Hourly capacity limit (hard cap)**: Always enforced. Daily budget never bypasses it. Only projected breaches of this hourly hard-cap budget trigger emergency shortfall alarms.
- **Daily soft limit**: Combined with the hourly soft limit by taking the smaller limit. Never triggers emergency alarms.
- **Price optimization**: Can reshape the daily plan if price shaping is enabled.

## Insights

These are exposed on the PELS Insights device:

- `pels_hourly_limit_kw` (effective hourly soft limit in kW)
- `pels_daily_budget_remaining_kwh`
- `pels_daily_budget_exceeded`
- `pels_limit_reason` (indicates whether limits are due to hourly or daily budget)
