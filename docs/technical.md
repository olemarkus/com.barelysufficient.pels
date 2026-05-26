---
title: Technical Reference
description: Internal planner behavior, budget logic, cooldowns, estimation rules, and system assumptions used by PELS.
---

# Technical Reference

This document explains the internal logic and assumptions PELS uses to manage your devices. It uses the public vocabulary from the user guide in headings and prose. Raw planner terms are shown only in code-style text or where they are still part of diagnostics, metrics, or existing Homey Flow card names.

## Table of Contents

- [Permissions](#permissions)
- [Capacity Budget Model](#capacity-budget-model-hourly)
- [Terminology and Units](#terminology-and-units)
- [Hour Transitions](#hour-transitions)
- [Cooldown Logic](#cooldown-logic)
- [Priority Swapping](#priority-swapping)
- [Limiting Order](#limiting-order)
- [Resume Order](#resume-order)
- [Power Estimation](#power-estimation)
- [Per-Device Diagnostics](#per-device-diagnostics)
- [Power Usage Data Retention](#power-usage-data-retention)
- [Daily Budget Weighting Math](#daily-budget-weighting-math)
- [How PELS Drives Devices](#how-pels-drives-devices)

---

## Permissions

PELS requires the `homey:manager:api` permission to function. This permission grants access to Homey's internal device API (HomeyAPI), which PELS uses to:

1. **Discover devices** – List all devices in your home to find thermostats, water heaters, and other eligible devices
2. **Read device state** – Get current temperatures, power consumption, on/off states, and official EV charging state where available
3. **Control devices** – Set thermostat target temperatures, turn generic devices on/off, and pause/resume official EV chargers through `evcharger_charging`

This permission is what lets PELS act on Homey's full device graph the moment a measurement changes — every managed device, every capability, every state. Homey flags it because it is powerful; PELS uses it because that is exactly what whole-home capacity control requires.

---

## Capacity Budget Model (Hourly)

PELS uses an **hourly energy budget** model based on the Norwegian grid tariff system ("effektbasert nettleie"). Your capacity limit (e.g., 10 kW) represents the maximum average power you want to consume over any single hour. This is the **hard cap** – exceeding it triggers grid penalties.

### Terminology and Units

Canonical terminology and unit definitions are maintained in the user guide:

- [Getting Started: Terminology and Units](getting-started.md#terminology-and-units)

This technical document uses those same definitions.

### Hard Cap and Hourly Safe Pace

- **Hard cap**: Your contracted grid capacity limit (`limitKw`). This corresponds to an hourly hard-cap energy budget of `limitKw` kWh for each hour. Exceeding this for a full hour triggers penalties.
- **Hourly safe pace**: A dynamic run-rate limit derived from the hourly budget after the safety margin and the time remaining. PELS starts limiting managed devices when power exceeds this, giving time to react.
- **Manual action needed**: Triggered when PELS projects an hourly hard-cap budget breach at the current run rate and cannot limit any more devices. Diagnostics may still call this `shortfall`.

The Overview label **Safe pace now** can come from the hourly safe pace, daily budget pace, or both. This section describes the hourly capacity side.

### Dynamic Hourly Safe Pace

Rather than simply comparing instantaneous power against your hard cap, PELS calculates an hourly safe pace that adapts throughout each hour. Internal code and diagnostics may call this the `softLimit`.

1. **Hourly budget after safety margin**: Your hard cap minus margin (e.g., 10 kW - 0.2 kW = 9.8 kWh per hour)
2. **Used**: Energy already consumed this hour (tracked via power samples)
3. **Remaining**: Budget minus used energy
4. **Time left**: Minutes remaining until the hour ends
5. **Burst rate**: Remaining kWh ÷ time left = maximum instantaneous power allowed

**Example**: If you've used 5 kWh with 30 minutes left in the hour and have a 10 kWh hard-cap budget:
- Remaining: 10 - 5 = 5 kWh
- Time left: 0.5 hours
- Burst rate: 5 ÷ 0.5 = 10 kW allowed

### Sustainable Rate Cap (Hourly Capacity Only)

To prevent "end of hour bursting" where devices ramp up to use remaining budget then overshoot the next hour, the hourly safe pace is capped at the sustainable rate during the last ~10 minutes. This means even if there is available power at 11:55, PELS will not turn on 5 kW of heaters that would overshoot noon.

End-of-hour capping is hourly-only by design — the daily budget is a pacing target and there is no grid penalty for landing slightly above it at any particular minute, so the planner stays free to make the right call at 23:55.

---

## Hour Transitions

When a new hour begins:

1. Energy tracking resets (new bucket starts at 0 kWh)
2. The hourly safe pace recalculates based on a full hour of remaining time
3. Devices that were limited may become eligible to resume
4. Any "hourly budget exhausted" state is cleared

PELS handles this automatically—there's no manual intervention needed.

---

## Daily Budget (Soft Constraint)

The daily energy budget is a **soft constraint** that helps pace energy use throughout the day. Unlike the hourly capacity limit:

- **Never triggers manual-action alarms**: If PELS cannot limit enough devices to meet the daily budget, it continues operating without emergency alarms.
- **No end-of-hour capping**: Daily budget pacing is not time-critical, so it does not apply the sustainable rate cap.
- **Combined with hourly**: The planner uses the smaller of the hourly safe pace and daily budget pace for limiting decisions.
- **Budget exemption is control-only**: Budget-exempt devices are ignored by daily-budget control, but their real usage still appears in reporting and they still count for hourly capacity protection.

See [Daily Energy Budget](daily-budget.md) for detailed documentation.

## Daily Budget Weighting Math

Advanced daily-budget tuning (background usage reserve, managed device flexibility, and confidence blending) is documented in:

- [Daily Budget Weighting Math (Advanced)](daily-budget-weights.md)

That document includes the exact formulas used in code and numeric examples for how each parameter changes the plan.

---

## Cooldown Logic

To prevent rapid on/off cycling that could damage equipment or annoy occupants, PELS enforces cooldown periods:

### Limit Cooldown (60 seconds)

- After limiting any device, wait 60 seconds before considering whether devices can resume
- Also applies after detecting overshoot conditions
- Prevents oscillation when power measurements fluctuate

### Resume Cooldown (base 60 seconds)

- After resuming a device, wait at least 60 seconds for power measurements to stabilize
- If a resume is followed by overshoot or new limiting, this cooldown delays the next restart by increasing amounts up to 5 minutes
- Only one device is resumed per planning cycle
- Prevents multiple devices turning on simultaneously before measurements settle

### Available-Power Flow Card Step-Down Cooldown (60 seconds)

- The **"Is there available power for device?"** Flow condition checks available power for the selected device. The card tracks the same device's **expected/usable** power estimate (prefers `expectedPowerKw` over raw `measuredPowerKw` when available)
- If that tracked/expected usable draw drops by at least 0.15 kW, the condition stays `false` for 60 seconds before allowing another increase
- Pure measurement-only dips that do not change the tracked/expected usable draw do **not** start this cooldown
- The same card also respects recent same-device PELS limit/resume cooldowns
- Repeated failed re-activations on the same device also increase the available-power requirement before the card returns `true`
- This is intended to absorb charger and water-heater step changes without forcing users to build manual hysteresis ladders in Homey flows

### Why These Timers Matter

Power measurements have inherent latency and variance. A heater turning on takes time to ramp up and be reflected in meter readings. Without cooldowns, PELS might see available power, resume a device, then immediately see overshoot before the measurement stabilizes.

---

## Priority Swapping

When a high-priority device is off and there isn't enough available power to resume it, PELS can make room by limiting lower-priority devices that are currently on:

1. Find the off device with the highest priority (lowest number)
2. Calculate how much available power is needed to resume it
3. Look for ON devices with lower priority (higher numbers)
4. If limiting those lower-priority devices would free enough power, do the swap
5. The lower-priority devices are tracked and will not resume until the high-priority device is back on

**Example**: Your kid's room heater (priority 1) is off, bathroom heater (priority 3) is on. If there's not enough available power for both, PELS will turn off the bathroom to heat the kid's room.

---

## Limiting Order

When power exceeds the safe pace, devices are limited in priority order:

1. **Lowest priority first** (highest number): Priority 5 is limited before priority 3
2. **Multiple devices per plan**: PELS may limit more than one device in a single plan to cover the overshoot; actions are still throttled per device
3. **Respect cooldowns**: No rapid toggling
4. **Resume grace**: Recently resumed devices are protected from being limited again for ~3 minutes unless overshoot is severe (>= 0.5 kW)
5. **Optional minimum temperature**: A device can be configured to drop to a minimum setpoint instead of turning fully off. Devices already at that temperature are skipped.

---

## Resume Order

When available power returns:

1. **Highest priority first** (lowest number): Priority 1 resumes before priority 3
2. **One device per cycle**: Wait for power measurement after each resume
3. **Hysteresis buffer**: Require extra available power beyond the device's power draw to prevent immediate limiting. A hard minimum post-reserve margin of 0.25 kW is enforced on every resume regardless of device size.
4. **Delayed restart after failed activation**: Devices that are resumed and then quickly need to be limited again require increasingly more available power before the next resume attempt
5. **Respect swap targets**: If a lower-priority device was limited for a higher-priority device, the high-priority one must resume first

For EV chargers, resume is only attempted when the charger is currently resumable. Chargers that are unplugged, discharging, missing a usable EV charging state, or missing a usable power estimate are marked `inactive` instead of limited. This keeps capacity suppression distinct from device unavailability.

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

For devices configured with the built-in **stepped load** control model, resume planning uses the configured per-step **planning power** instead of this generic estimator. In that mode:
- The selected step, measured power, and planning power are intentionally separate values.
- `measure_power = 0` does **not** imply the device is set to `off`; it only means the device is not drawing right now.
- The **Set expected power for device** Flow action is rejected for stepped-load devices.
- Capacity limiting uses the device's normal **When limiting** behavior: either `Turn off` or `Set to step`.
- Step resume starts at the lowest active step and only climbs toward the highest step when available power and budget allow it.
- PELS expects vendor-specific flows to report the selected step back through **Report stepped load for [device] as [step]** or **Report stepped load for [device] matching [power]** unless the device exposes that state generically.

Official EV chargers are supported only when they expose both `evcharger_charging` and `evcharger_charging_state`. PELS uses `evcharger_charging` for pause/resume control and never falls back to generic `onoff` for EV actuation.

PELS combines the estimate with measured power on every cycle, so the actual control loop is anchored in reality:
- Resumes one device at a time so each restart is attributable
- Waits for the next measurement before considering another resume
- Adds a hysteresis buffer so a restart never relies on a single estimate alone

For limiting decisions, devices reporting `measure_power = 0` are treated as non-contributing and are skipped rather than falling back to expected power.

For stepped-load devices, limiting relief is computed conservatively from **live measured power**, while resume/step-up budgeting uses the configured **planning power** of the target step. While any other managed device is still limited, stepped devices are capped at their **lowest non-zero step** — resuming from off to that step is allowed, but climbing higher is blocked until all limited devices have recovered.

For `meter_power`, PELS computes an average kW from the change in kWh over time and updates the peak. If the counter decreases (reset/rollover), the delta is ignored and the baseline is reset.

---

## Per-Device Diagnostics

PELS keeps a compact **21-day** rolling diagnostics history per managed device. These diagnostics are shown in the settings UI device detail panel and are intended for troubleshooting, not control.

### Unmet Demand vs Starvation

- **Unmet demand** means the device is below the state PELS would prefer right now.
- **Starvation** means that unmet demand stayed unmet because PELS kept blocking the device.
- Starvation is therefore a **subset** of unmet demand.

For temperature devices, unmet demand means the desired target exceeds the currently applied target by at least **0.5 C**. For binary on/off devices, unmet demand means the device is off while PELS would otherwise want it on.

### Starvation Cause Split

Blocked unmet-demand time is split into:

- **Blocked by available power**: insufficient available power under the current active safe pace. This includes cases where the daily budget lowers the effective pace.
- **Blocked by cooldown/delayed restart**: global resume cooldown, limit cooldown, resume throttling, or per-device failed-activation delay.

### EV Scope

EV chargers are intentionally excluded from unmet-demand and starvation metrics in v1. PELS can tell whether it paused or resumed an EV charger, but it does **not** know the charger's real charging objective such as target SoC or ready-by time.

EV chargers are still included in:

- **Hysteresis metrics** such as internal `shed -> restore` and `restore -> setback` cycles
- **Penalty metrics** such as penalty bump count, current penalty level, and max penalty level seen

### Hysteresis And Penalty Metrics

PELS tracks:

- Limit count and resume count
- Average `shed -> restore` duration
- Average, shortest, and longest `restore -> setback` duration
- Failed activation count and stable activation count
- Penalty bump count, current penalty level, and max penalty level seen in the window

### Debug Logging

The debug logging topic **`diagnostics`** emits diagnostics-specific logs. It is separate from the plan topic and is meant for validating this feature without enabling broad planner logs.

When enabled, it logs:

- persisted diagnostics load, repair, and prune actions
- throttled persistence flushes
- skipped attribution after long observation gaps
- unmet-demand start/end transitions
- block-cause changes between `headroom`, `cooldown_backoff`, and `not_blocked`
- limit/resume cycle completions
- activation attempt lifecycle transitions and penalty changes

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

## How PELS Drives Devices

### Supported Devices

PELS manages any Homey device that exposes the capabilities the planner needs:

- **Devices with power-limit control**: a usable power-estimate path (`measure_power`/`meter_power`, `settings.load`, device Energy settings, Homey Energy metadata, or Homey live `values.W`).
- **Price-only temperature devices**: `target_temperature` + `measure_temperature` is enough for mode and price-based control, even without a power estimate.
- **On/off devices**: `onoff` plus a usable power-estimate path.

Devices ship **disabled by default**, so you stay in control of what PELS touches — enable management and control device-by-device from the Devices tab. Devices without a usable estimate are listed for visibility and can still run mode/price control on temperature devices. Add an Energy value in Homey or a `settings.load` value, enable **Limit** on the device, and PELS picks it up on the next planning cycle.

### Available-Power Check For Devices With Power-Limit Control

The **"Is there available power for device?"** Flow condition answers "Can this device safely draw another _X_ kW right now?" for chargers, water heaters, and any other power-limit-controlled load. It evaluates:

- Current available power (safe pace minus current load)
- Same-device cooldown state after recent step-downs or PELS limit/resume events
- Device's expected usage (estimator order: flow override → `settings.load` → measured peak from `measure_power`/`meter_power`/Homey live `values.W` → device Energy settings (`energy_value_on`/`energy_value_off`) → Homey Energy metadata (`usageOn-usageOff`, `usageOn`, `W`) → fallback **1 kW**). If `settings.load` is configured for a device, the Flow action uses `settings.load` directly and the override is skipped.
- A conservative fallback of **1 kW** when no estimate exists, so PELS never reports phantom capacity

PELS never reports available power against a zero or unknown estimate — the answer is always grounded in a real number.

When the card is held by cooldown, diagnostics may show a `headroom cooldown (...)` reason. The user-facing status line frames this as waiting for the power reading to stabilise.

### Thermostats and Water Heaters

PELS is purpose-built for devices with thermal mass — rooms, tanks, floor loops — where short pauses do not move the temperature. That is exactly the load profile that dominates a winter peak hour, which is why PELS makes the biggest difference here.

### Power Meter Behavior

PELS reacts to your power meter in real time. With a fast, steady meter you can run tight safety margins; with a slower meter, widen the margin and PELS will pace accordingly.

### Device Response Time

Heaters and chargers on local protocols respond within seconds; cloud-mediated device apps can take longer to acknowledge. Either way, PELS waits a cooldown cycle for the meter reading to settle before the next move, so every decision is grounded in a measurement that already reflects the previous action.

### Hourly Enforcement

PELS enforces the hard cap on the **current hour**, the same hour your grid tariff is measured against. The sustainable rate cap protects the boundary across the hour roll, so the next hour starts clean.

### Local Control

PELS controls devices through Homey's local API where it's available — no cloud round-trip on the PELS side of the control path. Device apps that bridge to the cloud add their own latency on top.

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

Homey Energy pricing and Flow tag pricing (Power by the Hour or any other provider) store hourly prices exactly as supplied and feed them straight into the planner. PELS treats the source's numbers as authoritative, so adding a new region is a configuration choice in Homey, not a code change in PELS.
