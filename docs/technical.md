# PELS - Technical Documentation

This document explains the internal logic and assumptions PELS uses to manage your devices.

## Table of Contents

- [Permissions](#permissions)
- [Capacity Budget Model](#capacity-budget-model)
- [Hour Transitions](#hour-transitions)
- [Cooldown Logic](#cooldown-logic)
- [Priority Swapping](#priority-swapping)
- [Shedding Order](#shedding-order)
- [Restoration Order](#restoration-order)
- [Power Estimation](#power-estimation)
- [Power Usage Data Retention](#power-usage-data-retention)
- [Assumptions and Limitations](#assumptions-and-limitations)

---

## Permissions

PELS requires the `homey:manager:api` permission to function. This permission grants access to Homey's internal device API (HomeyAPI), which PELS uses to:

1. **Discover devices** – List all devices in your home to find thermostats, water heaters, and other controllable devices
2. **Read device state** – Get current temperatures, power consumption, and on/off states
3. **Control devices** – Set thermostat target temperatures and turn devices on/off for load shedding and price optimization

Without this permission, PELS would not be able to see or control any devices. This is why Homey shows a warning that apps with this permission require more thorough review.

---

## Capacity Budget Model

PELS uses an **hourly energy budget** model based on the Norwegian grid tariff system ("effektbasert nettleie"). Your capacity limit (e.g., 10 kW) represents the maximum average power you want to consume over any single hour.

### Dynamic Soft Limit

Rather than simply comparing instantaneous power against your limit, PELS calculates a "soft limit" that adapts throughout each hour:

1. **Budget**: Your limit minus margin (e.g., 10 kW - 0.2 kW = 9.8 kWh budget per hour)
2. **Used**: Energy already consumed this hour (tracked via power samples)
3. **Remaining**: Budget minus used energy
4. **Time left**: Minutes remaining until the hour ends
5. **Burst rate**: Remaining kWh ÷ time left = maximum instantaneous power allowed

**Example**: If you've used 5 kWh with 30 minutes left in the hour and have a 10 kWh budget:
- Remaining: 10 - 5 = 5 kWh
- Time left: 0.5 hours
- Burst rate: 5 ÷ 0.5 = 10 kW allowed

### Sustainable Rate Cap

To prevent "end of hour bursting" where devices ramp up to use remaining budget then overshoot the next hour, the soft limit is capped at the sustainable rate (your budget in kW). This means even if you have headroom at 11:55, you won't turn on 5 kW of heaters that would overshoot noon.

---

## Hour Transitions

When a new hour begins:

1. Energy tracking resets (new bucket starts at 0 kWh)
2. The soft limit recalculates based on a full hour of remaining time
3. Devices that were shed may become eligible for restoration
4. Any "hourly budget exhausted" state is cleared

PELS handles this automatically—there's no manual intervention needed.

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
2. **One device at a time**: After shedding, wait for measurements to stabilize
3. **Respect cooldowns**: No rapid toggling

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

1. **Last known power**: If we've seen this device on before, use its measured power
2. **settings.load capability**: Some devices report their rated power
3. **Fallback**: Assume 1 kW if no better estimate available

This estimation is inherently imperfect, which is why PELS:
- Restores only one device at a time
- Waits for actual measurements before restoring more
- Uses a hysteresis buffer for safety

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
