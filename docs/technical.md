---
title: "How PELS Works: Capacity Budget, Cooldowns & Price Math"
description: Internal planner behavior, budget logic, cooldowns, estimation rules, and system assumptions used by PELS.
---

# Technical Reference

This document explains the internal logic and assumptions PELS uses to manage your devices. It uses the public vocabulary from the user guide in headings and prose. Raw planner terms are shown only in code-style text or where they are still part of diagnostics, metrics, or existing Homey Flow card names.

## Grid import limit

Grid import limit is independent of the hourly or 15-minute capacity limit. Enable either, both, or neither in **Limits & safety**. Existing installations keep capacity control on; grid import control starts off. The first release supports the Main home; meter areas retain their existing capacity controls.

PELS compares the latest accepted signed whole-home import reading with 95% of the configured grid limit. Negative power means export: solar production is not added back to this constraint. Above that working target, the next meter-driven plan reduces flexible loads immediately, without capacity-period energy grace or recent-resume protection. Device priorities, supported step reductions, configured floors and EV minimum charging current still apply. All admissions, including budget-exempt devices and Smart tasks, must fit measured grid headroom; price and solar policies cannot bypass it.

An undelivered reduction keeps the existing bounded 30-second pending-relief credit. Once device telemetry confirms delivery, a whole-home reading that remains high can request more reduction after the post-reduction wait of up to 15 seconds: an unrelated load may have consumed the freed space. A breach that holds steady is re-checked at most every 15 seconds while it lasts; one that grows, or a reading that moves meaningfully, is acted on at once. Restoration uses the existing clear band of up to 0.4 kW (bounded to 10% of the grid target for low limits), 60-second post-shed delay and adaptive 60–300-second resume cooldown. Restore batching is disabled while grid control is enabled.

This is an observed-power control loop, not electrical protection. Temporary overshoot can occur before the meter updates and devices respond. Use a whole-home net grid meter and choose a threshold appropriate to the connection. Telemetry gaps use the same existing 10-minute silence and frozen-reading policy as other limits, including its one-time fail-closed reduction. No separate grid timeout is introduced.

Capacity-period energy tracking and peak history continue when Capacity limit is off, but its pacing, exhaustion holds, projections and shortfall/manual-action verdicts do not control devices. Grid pressure has its own reason and status, and does not fire capacity-period shortfall Flows.

Plans that look ahead use one planning ceiling: the hard cap minus the safety margin while Capacity limit is on, the grid import target while Grid import limit is on, and the lower of the two when both are. The daily budget caps each hour at it, smart tasks reserve room under it, the weather suggestion and the daily budget's recommended maximum are sized from it, and the daily-budget warning names the limit that sets it. The smart-task "maxed out" note names the limit that household import has reached: 98% of the hard cap, or the grid import target. With neither limit on there is no planning ceiling: no hour is capped by a power limit, smart tasks reserve no room, and a smart task granted both extra permissions plans at its device's top charging or heating level. These forecasts spend the instantaneous grid target as an hourly rate, an approximation; live planner admission still enforces measured grid headroom. Because that limit is instantaneous, a smart task in a home without solar panels never plans a charging or heating level above the grid import target; with solar panels, export can make room for it, so live control decides.

## Permissions

PELS requires the `homey:manager:api` permission to function. This permission grants access to Homey's internal device API (HomeyAPI), which PELS uses to:

1. **Discover devices** – List all devices in your home to find thermostats, water heaters, and other eligible devices
2. **Read device state** – Get current temperatures, power consumption, on/off states, and official EV charging state where available
3. **Control devices** – Set thermostat target temperatures when allowed for that device, turn devices on/off, and pause/resume official EV chargers through `evcharger_charging`

This permission is what lets PELS act on Homey's full device graph the moment a measurement changes — every managed device, every capability, every state. Homey flags it because it is powerful; PELS uses it because that is exactly what whole-home capacity control requires.

---

## Capacity Budget Model

PELS converts the configured hard cap into an energy allowance for each capacity period. The default is a whole hour, matching Nordic hourly capacity tariffs. A per-home 15-minute option matches quarter-hour peak measurement, used by Belgium's capacity tariff and 15-minute peak tariffs in other markets. A 10 kW cap therefore means 10 kWh per hour or 2.5 kWh per quarter.

### Terminology and Units

Canonical terminology and unit definitions are maintained in the user guide:

- [Getting Started: Terminology and Units](getting-started.md#terminology-and-units)

This technical document uses those same definitions.

### Solar Accounting

When Homey Energy reports solar production, PELS keeps two accounting figures separate. The net grid import drives hard-cap protection, daily-budget totals, and billed-usage buckets; negative export is floored at zero for kWh totals. Gross consumption (`net + generation`) is used only where the UI or smart-task reservation needs to understand real managed/background usage before solar production offsets it.

### Hard Cap and Capacity Safe Pace

- **Hard cap**: The configured average-power ceiling (`limitKw`) for the selected period.
- **Capacity safe pace**: A dynamic run-rate limit derived from the period allowance after the safety margin and the time remaining. PELS starts limiting managed devices when power exceeds this, giving time to react.
- **Manual action needed**: Triggered when PELS projects a hard-cap breach in the current capacity period and cannot limit any more devices. The **Hard cap breach imminent for at least...** trigger fires the same condition only once it has lasted a chosen number of seconds. Diagnostics may still call this `shortfall`.

The Overview label **Safe pace now** can come from the capacity safe pace or the daily budget pace, and the Power-now subline names which one it is. This section describes the capacity side.

### Dynamic Capacity Safe Pace

Rather than simply comparing instantaneous power against your hard cap, PELS calculates a safe pace that adapts throughout the selected period. Internal code and diagnostics may call this the `softLimit`.

1. **Period allowance after safety margin**: `(hard cap − margin) × period hours` (for example, 9.8 kWh hourly or 2.45 kWh per quarter)
2. **Used**: Energy already consumed in this period (tracked via power samples)
3. **Remaining**: Budget minus used energy
4. **Time left**: Minutes remaining until the period ends
5. **Burst rate**: Remaining kWh ÷ time left = maximum instantaneous power allowed (on the 15-minute period this is additionally capped at the sustainable rate; see [End-of-Period Drain](#end-of-period-drain) below)

**Example**: If you've used 5 kWh with 30 minutes left in the hour and have a 10 kWh hard-cap budget:
- Remaining: 10 - 5 = 5 kWh
- Time left: 0.5 hours
- Burst rate: 5 ÷ 0.5 = 10 kW allowed

### End-of-Period Drain

On the hourly period, PELS gradually tightens the capacity safe pace down to the sustainable rate as the hour ends, so devices are not ramped up to spend a leftover allowance right before the boundary. Slow device apps may still carry some load briefly across the boundary, and the next measured sample corrects the plan.

A 15-minute quarter is too short to wind down gradually, so it never bursts in the first place: the safe pace never goes above the hard cap minus the safety margin. Energy you did not use early in a quarter is not spent later in it. The safety margin is your buffer, so size it for your slowest device. The pace still drops below that level after a heavy start, so the quarter's average stays under the hard cap.

This drain applies only to the capacity controller. The daily budget is a pacing target and has no equivalent period-boundary penalty.

---

## Capacity-period Transitions

When a new capacity period begins:

1. Energy tracking resets (new bucket starts at 0 kWh)
2. The capacity safe pace recalculates with the full period remaining
3. Devices that were limited may become eligible to resume
4. Any exhausted-period state is cleared

PELS handles this automatically—there's no manual intervention needed.

---

## Daily Budget (Soft Constraint)

The daily energy budget is a **soft constraint** that helps pace energy use throughout the day. Unlike the capacity limit:

- **Never triggers manual-action alarms**: If PELS cannot limit enough devices to meet the daily budget, it continues operating without emergency alarms.
- **No period-boundary tightening**: Daily budget pacing is not time-critical, so it does not tighten toward the sustainable rate as a capacity period ends.
- **Combined with the capacity pace**: The planner uses the smallest enabled capacity pace, daily budget pace and grid import target for limiting decisions.
- **Budget exemption is control-only**: Budget-exempt devices are ignored by daily-budget control, but their real usage still appears in reporting and they still count toward grid import and capacity limits.

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
- When grid import control is off, previously limited devices, binary or stepped, may resume in a bounded batch (up to three) when fresh measurements show ample available power; a running stepped device's step-ups remain one at a time
- Every held device waits out the cooldown; the one that resumes first (turned-off devices before stepped increases before thermostat raises, by priority within each) shows the countdown and the rest show that other devices are ahead
- Prevents an unbounded set of devices turning on simultaneously before measurements settle

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
3. **Hysteresis buffer**: Require extra available power beyond the device's power draw to prevent immediate limiting. The buffer scales with the device: 10% of its draw plus 0.1 kW, bounded to 0.2–0.6 kW.
4. **Delayed restart after failed activation**: Devices that are resumed and then quickly need to be limited again require increasingly more available power before the next resume attempt
5. **Respect swap targets**: If a lower-priority device was limited for a higher-priority device, the high-priority one must resume first

For EV chargers, resume is only attempted while the charger can actually be driven. A charger that is unplugged, discharging, reported unavailable by Homey, or still inside PELS's retry wait after a command that never landed is marked `inactive` instead of limited. This keeps capacity suppression distinct from device unavailability. (A charger that does not report a usable EV charging state at all is not marked `inactive` — it is dropped from the device list entirely, because the state is a capability contract.)

---

## Home Battery

A managed home battery is a limiting candidate at its place in the mode's priority list (last by default). When the [Limiting Order](#limiting-order) reaches it, PELS first caps its charge, then raises its discharge to cover the remaining overshoot. The discharge always leaves a small import under the house's draw (half the battery's own power step, at least 100 W), so holding the limit never pushes the house into export.

- **Credit while the battery settles.** A battery needs a moment to follow a new setpoint. For up to **30 seconds** after PELS caps a charge or raises a discharge, the relief it asked for counts as already delivered, so PELS does not limit extra devices for power that is on its way.
- **No credit for a battery that does not follow.** Once those 30 seconds pass, a limit the battery has not followed counts for nothing: PELS stops asking it for more and limits the next devices as it would without a battery. A battery that keeps ignoring PELS is handed back. An empty battery delivers nothing, so PELS moves on in the same way.
- **Hand-back through resume.** Leaving a limit is a resume in priority order, under the same gates as any device: the resume cooldowns, meter settling, one resume per cycle, and the hysteresis buffer. PELS hands the battery back once the house has room for the charge its own mode will take; if PELS did not see it charging when it took over, it waits for room for the battery's full charge rate. Devices below the battery wait for its turn, so a smaller device lower in the order cannot take the room first every cycle. The discharge PELS holds is never spent on a hand-back: the battery steps its discharge down first.
- **Restart record.** Before PELS first switches a battery to its Homey or API mode, it saves the mode the battery was in. The record is removed only after the battery has been handed back, so after a restart or a crash PELS hands back every battery it still holds, to the mode it saved.
- **Power-limit control.** On by default. Off, PELS never takes the battery over: it is no limiting candidate and no surplus consumer, any hold PELS has on it is handed back at once, and its charge counts as household load. Its discharge still stays out of the solar surplus, and while **Managed by PELS** is on PELS still reads it and shows it on the Overview. The **Enable/Disable power-limit control for device** Flow cards set it like any device's.

Grid charging counts toward the hard cap and the daily budget like any load. On a meter outage the one-time fail-closed pass hands the battery back instead of raising its discharge, and Simulation mode hands it back too.

---

## Power Estimation

PELS needs to estimate how much power a device will draw when turned on. One ordered ladder decides it, and it always produces a number — there is no "unknown" left for a consumer to interpret:

1. **Manual override**: From the "Set expected power for device" Flow action. A manual value is an instruction, so it wins outright — including over a higher measured reading, and including on a device that declares `settings.load`. (The action is still rejected for stepped-load devices, which are sized per configured step.)
2. **`settings.load` (legacy/custom app setting)**: If present and > 0, use it as expected power
3. **Measured peak**: Highest draw PELS has actually observed, from `measure_power`/`meter_power` (and Homey live report `values.W` for measured updates). Kept on a 30-day rolling window and remembered across restarts: a device that keeps reaching its peak holds it, while a one-off spike that never repeats ages out and the next reading takes over.
4. **Device Energy settings (Homey Advanced Settings → Energy)**:
   - Use controllable delta when both are set: `energy_value_on - energy_value_off` (clamped to >= 0)
   - Otherwise use `energy_value_on`
5. **Homey Energy metadata** (`energyObj`/`energy`) when available:
   - Approximation delta: `approximation.usageOn - approximation.usageOff` (clamped to >= 0)
   - Approximation on-state: `approximation.usageOn`
   - Fallback to `W` when the device is not explicitly off
6. **Fallback**: Assume 1 kW when nothing above describes the device — 1.38 kW for an EV charger, the typical single-phase charging start

A declared `settings.load` deliberately outranks the measured peak: it is what the device says about itself, and the way to correct a wrong one is the manual override on the rung above.

The manual override is remembered across restarts too. Both it and the learned peak used to live only in memory, so a restart quietly discarded the figure you had entered and every peak PELS had observed.

For devices configured with the built-in **stepped load** control model, resume planning uses the configured per-step **planning power** instead of this generic estimator. In that mode:
- The selected step, measured power, and planning power are intentionally separate values.
- `measure_power = 0` does **not** imply the device is set to `off`; it only means the device is not drawing right now.
- The **Set expected power for device** Flow action is rejected for stepped-load devices.
- Capacity limiting reads the device's **When limiting** behavior as the *limit* it may go down to — `Turn off` means "as far as off", `Set to step` means "as far as the lowest active step". PELS goes only as deep as the shortfall requires, so a device set to `Turn off` is often left running at a lower step rather than switched off.
- Step resume starts at the lowest active step and only climbs toward the highest step when available power and budget allow it.
- PELS expects vendor-specific flows to report the selected step back through **Report stepped load for [device] as [step]** or **Report stepped load for [device] matching [power]** unless the device exposes that state generically.
- For supported stepped-load devices (such as compatible water heaters and Easee chargers), **built-in device control** lets PELS set the level directly instead of routing through your own Flow cards, and is on by default. PELS automatically leaves it off — with a notice on the device — when it detects a Homey Flow already writing that device's level, so the existing setup keeps working. To switch, turn off only the conflicting Flow action, then enable built-in device control in the device's **Setup** section.

Official EV chargers are supported only when they expose both `evcharger_charging` and `evcharger_charging_state`. PELS uses `evcharger_charging` for pause/resume control and never falls back to generic `onoff` for EV actuation. An Easee charger under built-in device control is the exception: PELS pauses it by setting the current to 0 A and resumes it at 6 A, so the charging session stays open (see [Easee EV Charger](/easee-ev-charger)).

PELS combines the estimate with measured power on every cycle, so the actual control loop is anchored in reality:
- Steps running stepped loads up one at a time; previously limited devices may use the bounded batch above when the available-power margin is large
- Waits for the next measurement before considering another resume
- Adds a hysteresis buffer so a restart never relies on a single estimate alone

For limiting decisions, devices reporting `measure_power = 0` are treated as non-contributing and are skipped rather than falling back to expected power.

For stepped-load devices, limiting relief is computed conservatively from **live measured power**, while resume/step-up budgeting uses the configured **planning power** of the target step. While any other managed device is still limited, stepped devices are capped at their **lowest non-zero step** — resuming from off to that step is allowed, but climbing higher is blocked until all limited devices have recovered.

For `meter_power`, PELS computes an average kW from the change in kWh between two readings, divided by the time between those same two readings as the device itself reported them — not by how often PELS happened to look. Devices publish a cumulative meter on their own schedule (a cloud-backed device may update only every few minutes), so pairing their energy with PELS's own refresh interval would overstate the rate by the ratio between the two. Until the device reports a new value there is no new information, so PELS records no reading for that device rather than treating the unchanged counter as a measured 0 kW. If the counter decreases (reset/rollover), the delta is ignored and the baseline is reset.

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

EV chargers are intentionally excluded from unmet-demand and starvation metrics in v1. EV Smart tasks do know the target SoC and ready-by time, but those belong to the Smart task status and history surfaces, not to per-device starvation diagnostics. See [Deadline Charging With State of Charge](/how-to-deadline-charging-soc) for the user setup.

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

- **Power support**: a way to report power (`measure_power`/`meter_power`, device Energy settings, Homey Energy metadata, or Homey live `values.W`). Limiting the device waits for its first actual reading. A `settings.load` value refines the *expected* power estimate, but it is not on its own enough to make a device manageable — PELS needs something that reports what the device is actually drawing.
- **Price-only temperature devices**: `target_temperature` + `measure_temperature` is enough for mode and price-based control, even without a power estimate.
- **On/off devices**: `onoff` plus a usable power-estimate path.

Supporting a device and limiting it are two different things. Energy settings and Homey's Energy metadata are enough for PELS to support a device and keep your choices for it. To limit or resume a device for power, PELS needs the device's own power reading: its `measure_power`, a `meter_power` that is moving, or the live value Homey Energy reports for it. Until that reading arrives:

- a temperature device still follows its mode targets and price shift, but PELS does not limit it for power and does not count its draw as managed usage;
- any other device waits, and PELS starts limiting it once its first reading arrives.

Devices ship **disabled by default**, so you stay in control of what PELS touches — enable management and control device-by-device from the Devices tab. Devices without a usable estimate are listed for visibility and can still run mode/price control on temperature devices. Add an Energy value in Homey, enable **Power-limit control** on the device, and PELS picks it up on the next planning cycle.

For a temperature device that another app or Flow controls, set **When the temperature changes outside PELS** to **Keep the new temperature**. The choice covers one thing: the device's temperature target. PELS continues reading and displaying its measured temperature and target, but does not change the target for modes, prices, Smart tasks, boosts, or power limiting. Every other control the device exposes still works: PELS can turn it off and on, and a device with power levels is still lowered a level at a time rather than only switched off.

### Limited temperature for a heating and cooling device

When PELS limits a device by setpoint, the **Limited temperature** is the point it may fall to: a heater set to 21 °C that is limited to 16 °C is allowed to cool down to 16 °C, and no further, until power allows it back up. That number is a floor, and for a heater it is the whole story.

A reversible unit — an air conditioner or a heat pump that also cools — has two stories. While it is heating, the same floor applies. While it is cooling, a floor is the wrong thing to hand it: setting a cooling unit *down* to 16 °C makes it work harder, which is the opposite of limiting. So a device that reports its own heating/cooling mode gets a second setting, **Limited temperature when cooling**, and that one is a ceiling: the point the room may rise to while the device is limited.

PELS reads which way the device is running from the device itself (its `thermostat_mode` capability) and applies the matching limit. A device that does not report a mode — a water heater, a radiator, floor heating — is treated as heating and only ever has the one limit.

Smart tasks measure temperature progress in the same direction: with an explicit cooling mode, the room must cool to reach its target; heating devices move toward the target as they warm. A device that does not report a mode, or reports `auto`, is treated as heating.

Caveats, in the order they tend to matter:

- **The cooling limit starts at 28 °C.** PELS fills it in alongside the heating limit, so a reversible unit is limited from its first peak rather than left running; change it to suit the room. It is used only while the device reports that it is cooling.
- **A limit on the wrong side of the target is not applied.** If the limited temperature would make the device work harder — a heating limit above its current target, or a cooling limit below it — PELS leaves that device's setpoint alone and limits other devices instead. A mode target can move past a limit that was fine when it was set.
- **`auto` mode is treated as heating.** A unit in `auto` may be cooling, but the mode alone cannot say, and PELS does not guess from the room temperature: the guess would flip every time the setpoint moved. A unit in `auto` that is actually cooling can be made to work *harder* by a heating limit, so do not leave limiting by temperature on for it: set its mode explicitly — cooling for the summer, heating for the winter — or have PELS limit it without changing its temperature, by turning it off or stepping it down instead.
- **Both limits stay in force under "Save as current mode target".** That policy switches off the price and solar offsets, not power limiting. If the device's temperature is changed outside PELS *while PELS is limiting its temperature*, that change is not saved as the mode's target — it is treated like any other outside change, and PELS brings the device back to its limit. A change made at any other time — including while PELS has the device turned off — is saved as usual.
- **"Keep the new temperature" still means no setpoint writes at all.** PELS limits such a device only by turning it off, or by stepping it down if it has power levels.

### Available-Power Check For Devices With Power-Limit Control

The **"Is there available power for device?"** Flow condition answers "Can this device safely draw another _X_ kW right now?" for chargers, water heaters, and any other power-limit-controlled load. It evaluates:

- Current available power (safe pace minus current load)
- Same-device cooldown state after recent step-downs or PELS limit/resume events
- Device's expected usage, from the single ladder in [Power Estimation](#power-estimation): manual override → `settings.load` → measured peak → device Energy settings → Homey Energy metadata → **1 kW** (1.38 kW for an EV charger)

PELS never reports available power against a zero or unknown estimate — the ladder ends on a fallback rather than on absence, so the answer is always grounded in a real number.

### Thermostats and Water Heaters

PELS is purpose-built for devices with thermal mass — rooms, tanks, floor loops — where short pauses do not move the temperature. That is exactly the load profile that dominates a winter peak hour, which is why PELS makes the biggest difference here.

### Power Meter Behavior

PELS reacts to your power meter in real time. With a fast, steady meter you can run tight safety margins; with a slower meter, widen the margin and PELS will pace accordingly.

A whole-home reading is what drives every planning cycle, so PELS is deliberate about what a gap in readings means. A reading counts as current for 60 seconds; beyond that the last good reading carries forward and PELS keeps acting on the decision it already made. A missing reading is never read as zero, because zero is a more favourable number than anything PELS has actually measured.

If readings stop for **10 minutes**, PELS stops trusting that decision and fails closed. It runs one final planning pass that limits every managed device to its floor: stepped devices drop to their lowest step, thermostats and water heaters go to their limited setpoint, and on/off loads turn off. Planning then pauses until a new reading arrives, and nothing resumes while the meter is silent, because resuming safely means knowing the current draw. When a new reading arrives, the next cycle plans normally and devices resume in priority order under the usual resume cooldown. Under Simulation mode the pass is computed and reported but never actuated, and it does not pause planning.

A meter that keeps reporting exactly the same number can count as stopped too, when the home's own devices show it should have moved. PELS compares the whole-home reading with the managed devices that report their power (W); a device that reports only the energy it has used (kWh) does not count, because that figure trails behind. If their combined draw moves by a kilowatt or more (or a quarter of the meter's value, on a home drawing more) and stays there while the whole-home reading keeps exactly the same value, the no-readings banner appears after two minutes, and after ten minutes PELS treats the meter as stopped from the moment the reading took that value, so a meter frozen for longer than that gets the fail-closed pass at once. That is a meter that has stopped updating, for example a HAN/P1 reader that lost contact with the electricity meter while its app keeps showing the last value. If the draw comes back before the ten minutes are up, the warning clears. Device readings get ten minutes to settle after the whole-home reading changes, because some devices report later than the meter does. A steady reading on its own is never treated as stopped (Homey reports a value only when it changes, and some meters only past a threshold), and nor is exactly 0 W, which a meter that cannot show export reports for as long as the home exports. A meter seen holding one value for twenty minutes and then moving on reports only on change, so for the next day its steady readings are not checked this way at all. Nor are they while a home battery, or a solar inverter that is producing, is connected to Homey: either can cover a device switching on and keep the grid reading still. A restart keeps a meter already treated as stopped, but a warning starts over. The stretch a suspect meter covered is marked unreliable in the usage history once it moves again.

A home whose meter has never reported at all is a different case: PELS builds no plan and leaves every device exactly as it is.

### Device Response Time

Heaters and chargers on local protocols respond within seconds; cloud-mediated device apps can take longer to acknowledge. Either way, PELS waits a cooldown cycle for the meter reading to settle before the next move, so every decision is grounded in a measurement that already reflects the previous action.

### Capacity-period enforcement

PELS enforces the hard cap on the selected **capacity period**: a clock hour for hourly tariffs or an aligned 15-minute quarter for quarter-hour peak tariffs. In hourly mode, the period-end drain tightens the safe pace toward the sustainable rate as the hour ends. In 15-minute mode the safe pace never rises above that rate. Either way the planner aims to cross into the next period near that steady rate. Slow device response can briefly carry some load across the boundary, and the next planning cycle corrects that if needed.

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

### Homey, Flow and Power by the Hour price schemes

Homey Energy pricing, Flow tag pricing (any provider) and Power by the Hour pricing store prices exactly as supplied and feed them straight into the planner. PELS treats the source's numbers as authoritative, so adding a new region is a configuration choice in Homey, not a code change in PELS.

The Power by the Hour source reads that app directly over Homey's app-to-app API (`GET /dap-prices` on `com.gruijter.powerhour`, added in its v8.10.0), so no flow is needed. It offers every electricity price device the app has paired — hourly and quarter-hourly alike — and the owner picks the one that prices their home when there is more than one. The prices are that app's own: the spot price for its bidding zone with whatever markups the owner configured there, and **no grid tariff** unless they added it themselves as a fixed or time-of-day markup. Gas price devices are not offered; they price per m³ and would be meaningless to the planner.

Two consequences of the app publishing only the current period onwards:

- Today's stored day is **merged into**, never replaced, so hours already read are kept as the day goes on. A home that switches to this source mid-afternoon simply has no prices for that morning — PELS does not invent them.
- Switching to a different price device **drops** the days built from the previous one, because two devices are two bidding zones and a day half-priced in each is not a series anything can read.
