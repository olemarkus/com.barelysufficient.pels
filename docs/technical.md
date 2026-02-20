# PELS - Technical Documentation

This document explains the internal logic and assumptions PELS uses to manage your devices.

## Table of Contents

- [Permissions](#permissions)
- [Capacity Budget Model](#capacity-budget-model)
- [Terminology and Units](#terminology-and-units)
- [Hour Transitions](#hour-transitions)
- [Cooldown Logic](#cooldown-logic)
- [Priority Swapping](#priority-swapping)
- [Shedding Order](#shedding-order)
- [Restoration Order](#restoration-order)
- [Power Estimation](#power-estimation)
- [Power Usage Data Retention](#power-usage-data-retention)
- [Daily Budget Weighting Math](#daily-budget-weighting-math)
- [Assumptions and Limitations](#assumptions-and-limitations)

---

## Permissions

PELS requires the `homey:manager:api` permission to function. This permission grants access to Homey's internal device API (HomeyAPI), which PELS uses to:

1. **Discover devices** – List all devices in your home to find thermostats, water heaters, and other eligible devices
2. **Read device state** – Get current temperatures, power consumption, and on/off states
3. **Control devices** – Set thermostat target temperatures and turn devices on/off for load shedding and price optimization

Without this permission, PELS would not be able to see or control any devices. This is why Homey shows a warning that apps with this permission require more thorough review.

---

## Capacity Budget Model (Hourly)

PELS uses an **hourly energy budget** model based on the Norwegian grid tariff system ("effektbasert nettleie"). Your capacity limit (e.g., 10 kW) represents the maximum average power you want to consume over any single hour. This is the **hard cap** – exceeding it triggers grid penalties.

### Terminology and Units

Canonical terminology and unit definitions are maintained in the user guide:

- [User Guide: Terminology and Units](README.md#terminology-and-units)

This technical document uses those same definitions.

### Hard Cap vs Soft Limit

- **Hard cap**: Your contracted grid capacity limit (`limitKw`). This corresponds to an hourly hard-cap energy budget of `limitKw` kWh for each hour. Exceeding this for a full hour triggers penalties.
- **Soft limit**: A dynamic run-rate limit derived from the hourly soft budget `(limitKw - marginKw)` and time remaining. PELS starts shedding when power exceeds this, giving time to react.
- **Shortfall**: Triggers when PELS projects an hourly hard-cap budget breach at current run rate AND no more devices can be shed. This is the emergency "panic" state.

### Dynamic Soft Limit

Rather than simply comparing instantaneous power against your limit, PELS calculates a "soft limit" that adapts throughout each hour:

1. **Soft budget**: Your limit minus margin (e.g., 10 kW - 0.2 kW = 9.8 kWh soft budget per hour)
2. **Used**: Energy already consumed this hour (tracked via power samples)
3. **Remaining**: Budget minus used energy
4. **Time left**: Minutes remaining until the hour ends
5. **Burst rate**: Remaining kWh ÷ time left = maximum instantaneous power allowed

**Example**: If you've used 5 kWh with 30 minutes left in the hour and have a 10 kWh hard-cap budget:
- Remaining: 10 - 5 = 5 kWh
- Time left: 0.5 hours
- Burst rate: 5 ÷ 0.5 = 10 kW allowed

### Sustainable Rate Cap (Hourly Capacity Only)

To prevent "end of hour bursting" where devices ramp up to use remaining budget then overshoot the next hour, the hourly soft limit is capped at the sustainable rate (your hourly soft budget in kW) during the last ~10 minutes. This means even if you have headroom at 11:55, you won't turn on 5 kW of heaters that would overshoot noon.

**Note:** This end-of-hour capping only applies to the hourly capacity soft limit, not the daily budget soft limit. Daily budget violations are not time-critical in the same way – there's no grid penalty for exceeding a daily budget at any particular minute.

---

## Hour Transitions

When a new hour begins:

1. Energy tracking resets (new bucket starts at 0 kWh)
2. The soft limit recalculates based on a full hour of remaining time
3. Devices that were shed may become eligible for restoration
4. Any "hourly budget exhausted" state is cleared

PELS handles this automatically—there's no manual intervention needed.

---

## Daily Budget (Soft Constraint)

The daily energy budget is a **soft constraint** that helps pace energy use throughout the day. Unlike the hourly capacity limit:

- **Never triggers shortfall/panic**: If PELS cannot shed enough devices to meet the daily budget, it continues operating without emergency alarms.
- **No end-of-hour capping**: Daily budget soft limits are not time-critical, so they don't apply the sustainable rate cap.
- **Combined with hourly**: The planner uses the smaller of the hourly soft limit and daily soft limit for shedding decisions.

See [Daily Energy Budget](daily_budget.md) for detailed documentation.

## Daily Budget Weighting Math

Advanced daily-budget tuning (controlled usage weight, price flex share, and confidence blending) is documented in:

- [Daily Budget Weighting Math (Advanced)](daily_budget_weights.md)

That document includes the exact formulas used in code and numeric examples for how each parameter changes the plan.

---

## Cooldown Logic

To prevent rapid on/off cycling that could damage equipment or annoy occupants, PELS enforces cooldown periods:

### SHED_COOLDOWN (60 seconds)

- After shedding any device, wait 60 seconds before considering restoring devices
- Also applies after detecting overshoot conditions
- Prevents oscillation when power measurements fluctuate

### RESTORE_COOLDOWN (30 seconds)

- After restoring a device, wait 30 seconds for power measurements to stabilize
- Only one device is restored per planning cycle
- Prevents "restore avalanche" where multiple devices turn on simultaneously

### Why These Timers Matter

Power measurements have inherent latency and variance. A heater turning on takes time to ramp up and be reflected in meter readings. Without cooldowns, PELS might see "headroom available", restore a device, then immediately see overshoot before the measurement stabilizes.

---

## Priority Swapping

When a high-priority device is off and there isn't enough headroom to restore it, PELS can **swap** it with lower-priority devices that are currently on:

1. Find the off device with the highest priority (lowest number)
2. Calculate how much headroom is needed to restore it
3. Look for ON devices with lower priority (higher numbers)
4. If shedding those lower-priority devices would free enough headroom, do the swap
5. The swapped-out devices are tracked and won't restore until the high-priority device is back on

**Example**: Your kid's room heater (priority 1) is off, bathroom heater (priority 3) is on. If there's not enough headroom for both, PELS will turn off the bathroom to heat the kid's room.

---

## Shedding Order

When power exceeds the soft limit, devices are shed in priority order:

1. **Lowest priority first** (highest number): Priority 5 sheds before priority 3
2. **Multiple devices per plan**: PELS may shed more than one device in a single plan to cover the overshoot; actions are still throttled per device
3. **Respect cooldowns**: No rapid toggling
4. **Restore grace**: Recently restored devices are protected from re-shedding for ~3 minutes unless overshoot is severe (≥ 0.5 kW)
5. **Optional min temperature**: A device can be configured to drop to a minimum setpoint instead of turning fully off. Devices already at the shed temperature are skipped.

---

## Restoration Order

When headroom becomes available:

1. **Highest priority first** (lowest number): Priority 1 restores before priority 3
2. **One device per cycle**: Wait for power measurement after each restore
3. **Hysteresis buffer**: Require extra headroom beyond the device's power draw to prevent immediate re-shedding
4. **Respect swap targets**: If a device was swapped out for a higher-priority device, the high-priority one must restore first

---

## Power Estimation

PELS needs to estimate how much power a device will draw when turned on:

1. **Manual override**: From the "Set expected power for device" Flow action; takes precedence over other sources when present and remains until a higher measured reading arrives. Note: this Flow action refuses to set an override while `settings.load > 0` is configured.
2. **`settings.load` (legacy/custom app setting)**: If present and > 0 (and no manual override is active), use it as expected power
3. **Measured peak**: Last known peak derived from `measure_power`/`meter_power` (and Homey live report `values.W` for measured updates)
4. **Device Energy settings (Homey Advanced Settings → Energy)**:
   - Use controllable delta when both are set: `energy_value_on - energy_value_off` (clamped to >= 0)
   - Otherwise use `energy_value_on`
5. **Homey Energy metadata** (`energyObj`/`energy`) when available:
   - Approximation delta: `approximation.usageOn - approximation.usageOff` (clamped to >= 0)
   - Approximation on-state: `approximation.usageOn`
   - Fallback to `W` when the device is not explicitly off
6. **Fallback**: Assume 1 kW if no better estimate is available

This estimation is inherently imperfect, which is why PELS:
- Restores only one device at a time
- Waits for actual measurements before restoring more
- Uses a hysteresis buffer for safety

For shedding decisions, devices reporting `measure_power = 0` are treated as non-contributing and are skipped rather than falling back to expected power.

For `meter_power`, PELS computes an average kW from the change in kWh over time and updates the peak. If the counter decreases (reset/rollover), the delta is ignored and the baseline is reset.

---

## Power Usage Data Retention

PELS tracks power consumption over time using a tiered retention system:

### Hourly Data (30 days)
Full-resolution hourly buckets are kept for the last 30 days. Each bucket contains total energy consumed and the number of samples.

### Daily Summaries (365 days)
Older hourly data is automatically aggregated into daily summaries showing average consumption per hour.

### Hourly Patterns (permanent)
A 24×7 grid (hour of day × day of week) maintains running averages of your usage patterns. This helps identify when you typically use the most power.

Aggregation happens automatically when power data is saved—you don't need to manage this manually.

---

## Assumptions and Limitations

### Supported Devices

PELS only manages devices that expose the capabilities it needs:

- **Capacity-controlled devices**: need a usable power estimate path (`measure_power`/`meter_power`, `settings.load`, device Energy settings, Homey Energy metadata, or Homey live `values.W`).
- **Price-only temperature devices**: `target_temperature` + `measure_temperature` is sufficient for mode/price optimization, even when no usable power estimate exists.
- **On/off devices**: `onoff` plus a usable power estimate path.

Devices are **disabled by default**. You must explicitly enable management and control in the Devices tab.

Devices without any usable power estimate are listed for visibility and forced non-controllable for capacity. Temperature devices can still stay managed for mode/price-only behavior; non-temperature devices remain unmanaged until a usable estimate becomes available.

### Headroom check for capacity-controlled loads

The **"Is there headroom for device?"** Flow condition is intended for capacity-controlled devices such as EV chargers and water heaters. It answers "Can this device safely draw another _X_ kW right now?" by calculating:

- Current headroom (soft limit minus current load)
- Device's expected usage (estimator order: flow override → `settings.load` → measured peak from `measure_power`/`meter_power`/Homey live `values.W` → device Energy settings (`energy_value_on`/`energy_value_off`) → Homey Energy metadata (`usageOn-usageOff`, `usageOn`, `W`) → fallback **1 kW**). If `settings.load` is configured for a device, the Flow action will not set an override and `settings.load` is used directly.
- A conservative fallback of **1 kW** when no estimate exists, to avoid over-promising capacity

Using 0 kW as a fallback would risk reporting that capacity exists when the actual load is unknown, so PELS never reports headroom based on a zero/unknown estimate.

### Thermostats and Water Heaters

PELS is designed for devices that can tolerate being turned off temporarily without immediate consequences. It works best with thermal mass (the room or tank stays warm for a while).

### Power Meter Accuracy

PELS trusts your power measurements. If your meter has significant lag or variance, you may need larger margins.

### Device Response Time

Heaters typically have built-in delays before turning on. PELS assumes devices respond within a few seconds of receiving commands.

### No Predictive Control

Currently PELS is reactive—it responds to actual power consumption, not predicted future consumption. Future versions may add forecasting.

### Single Hour Focus

The budget model focuses on the current hour. It doesn't "save up" headroom from previous hours or plan ahead for the next hour (except via the sustainable rate cap).

### Local Control Only

PELS controls devices through Homey's local API. Cloud-only devices may have additional latency.

## Pricing Model

PELS supports three price schemes:

- **Norway** (spot + grid tariff + taxes/fees + support/adjustment)
- **Homey Energy** (values as provided by Homey)
- **Flow tag** (values as provided by flows)

### Norway Price Scheme

PELS stores spot prices as øre/kWh **ex VAT** from hvakosterstrommen.no. Norway hourly totals are computed from:

- Spot price (spotpris)
- Grid tariff energy component (nettleie)
- Provider surcharge (incl. VAT in settings; converted to ex VAT internally)
- Consumption tax (elavgift)
- Enova fee (enovaavgift)
- VAT (mva) where applicable
- Either electricity support (strømstøtte) or Norgespris adjustment, depending on the selected Norway pricing model

Calculation summary:

- `totalExVat = spot + gridTariff + providerSurchargeExVat + consumptionTax + enovaFee`

Norway pricing models:

- **Strømstøtte**:
  - `electricitySupportExVat = max(0, spotPriceExVat - threshold) * coverage`
  - `totalPrice = totalExVat * vatMultiplier - electricitySupportExVat * vatMultiplier`
- **Norgespris**:
  - `spotPriceIncVat = spotPriceExVat * vatMultiplier`
  - `eligibleShare = min(1, remainingMonthlyCapKwh / hourlyUsageEstimateKwh)` (or `0` if cap is exhausted)
  - `norgesprisAdjustment = (norgesprisTargetIncVat - spotPriceIncVat) * eligibleShare`
  - `totalPrice = totalExVat * vatMultiplier + norgesprisAdjustment`

Norgespris cap behavior:

- Target is fixed by policy at 40 øre/kWh ex. VAT (50 øre/kWh incl. VAT where VAT applies).
- Monthly cap is fixed by tariff group: 5000 kWh for `Husholdning`, 1000 kWh for `Hytter og fritidshus`.
- Cap tracking is month-based and resets at calendar month boundaries.
- Cap is consumed in chronological order for current/future hours in the loaded price window.
- Past hours in the same price window do not consume current cap.

All component rates are treated as ex VAT, and VAT is applied once after summing the components.

Current policy values:

- Electricity support threshold: 77 øre/kWh (ex VAT, 96.25 incl. VAT)
- Electricity support coverage: 90% above the threshold

Regional rules:

- VAT is 25% by default, but price area NO4 is VAT-exempt.
- Reduced consumption tax applies to Troms and Finnmark counties (fylker). Municipality-level exceptions are ignored.

### Homey and Flow Price Schemes

Homey Energy pricing and Flow tag pricing (Power by the Hour or other providers) store hourly prices exactly as provided and skip the Norwegian price breakdown logic.

## Future Work / TODOs

- Pricing strategies: current implementation assumes Norwegian spot + grid tariff + taxes/support. Introduce a pluggable price strategy interface (e.g., `PriceStrategy` with inputs for spot, tariffs, provider surcharges, taxes/VAT, support) so non-NO regions can drop in their own calculators without touching control logic. Keep aggregation/token outputs stable while swapping strategies.
