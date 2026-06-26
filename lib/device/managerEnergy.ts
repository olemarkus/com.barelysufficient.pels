import type { HomeyDeviceLike } from '../utils/types';
import { normalizeStateOfChargePercent } from './transport/stateOfCharge';

export type LiveDevicePowerWatts = Record<string, number>;

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
  typeof value === 'object' && value !== null ? value as UnknownRecord : null
);

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const extractLiveHomePowerWatts = (liveReport: unknown): number | null => {
  const report = asRecord(liveReport);
  if (!report || !Array.isArray(report.items)) return null;
  for (const rawItem of report.items) {
    const item = asRecord(rawItem);
    if (!item || item.type !== 'cumulative') continue;
    const values = asRecord(item.values);
    const watts = toFiniteNumber(values?.W);
    if (watts !== null) return watts;
  }
  return null;
};

/**
 * Gross PV generation in watts from the same `manager/energy/live` payload, or
 * `null` when no generation signal is present. PELS's whole-home `cumulative.W`
 * is NET grid power (consumption minus generation); to recover the authoritative
 * whole-home *actual consumption* (`net + generation`) for the managed/unmanaged
 * split, accounting needs the production term. Source per the solar plan: the
 * top-level `totalGenerated.W` aggregate, falling back to the `generator`-type
 * item. Generation is `+`-only; this never feeds the hard-cap import path.
 */
export const extractLiveGenerationWatts = (liveReport: unknown): number | null => {
  const report = asRecord(liveReport);
  if (!report) return null;
  const topLevel = toFiniteNumber(asRecord(report.totalGenerated)?.W);
  if (topLevel !== null) return Math.max(0, topLevel);
  if (!Array.isArray(report.items)) return null;
  for (const rawItem of report.items) {
    const item = asRecord(rawItem);
    if (!item || item.type !== 'generator') continue;
    const watts = toFiniteNumber(asRecord(item.values)?.W);
    if (watts !== null) return Math.max(0, watts);
  }
  return null;
};

/**
 * Read-only home-battery aggregate resolved from the fetched device list.
 *
 * Unlike `homePowerW`/`generationW` (which come from the whole-home energy
 * report), battery SoC is per-DEVICE, so this reads the home-battery devices
 * directly. A device is a home battery when its `class === 'battery'` OR it
 * declares the canonical Homey `homeBattery` energy role (`energyObj`/`energy`,
 * v12.3.0+).
 *
 * TWO SEPARATE CONCERNS — role membership vs emission:
 *   - `batteryDeviceIds` (the targeted-refresh re-poll set) = EVERY role-detected
 *     battery, INCLUDING offline ones. There is no periodic full refresh, so the
 *     id set is the only way a battery is re-read; dropping an offline battery's id
 *     would strand it (it could never recover when back online). Membership is
 *     therefore availability-agnostic.
 *   - The emitted aggregate (`batterySoc`/`batteryPowerW`/`batteryDeviceCount`) =
 *     only AVAILABLE (`available !== false`) batteries with VALID caps. Homey
 *     retains an offline device's last `measure_battery`/`measure_power`, so an
 *     offline battery's caps are stale and must never be surfaced as fresh.
 *
 * BOUNDARY VALIDATION — every emitted number is validated external input:
 *   - `measure_battery` → finite AND in range [0,100] (`normalizeStateOfChargePercent`,
 *     the repo's codified SoC rule); a driver bug returning -5/150 is rejected.
 *   - `measure_power` → finite signed watts (`+` charging / `−` discharging); no
 *     range bound by design.
 *   A malformed `capabilitiesObj`, a missing/null cap value, or a non-record device
 *   all resolve to "this battery has no valid reading", never a fabricated number.
 *
 * Aggregation is ALL-OR-NULL per field: SUM the powers / mean the SoCs only when
 * EVERY available battery contributes a valid value, else `null`. A partial subset
 * is never silently summed/meaned (a dropped term could understate the total and
 * flip its sign), and one invalid/out-of-range battery suppresses that field.
 * TODO(battery): capacity-weight the SoC mean once per-battery kWh capacity is
 * surfaced — simple mean skews when batteries differ in size.
 *
 * A `null` field means "no valid reading from an available battery this poll".
 * There is no retained value — the producer emits only when both fields are
 * concrete validated numbers, and drops otherwise.
 *
 * READ-ONLY: this value is surfaced for awareness only. It NEVER feeds the
 * hard-cap import path — capacity/shed/restore stay on net grid `cumulative.W`.
 */
export type BatteryStateAggregate = {
  /** Mean SoC (%, 0–100) across present battery devices, or `null` when absent. */
  batterySoc: number | null;
  /** Summed signed power (W); `+` charging / `−` discharging, or `null` when absent. */
  batteryPowerW: number | null;
  /** Number of AVAILABLE home-battery devices contributing to the aggregate (0 when none). */
  batteryDeviceCount: number;
  /**
   * IDs of the detected home-battery devices. Home batteries are non-managed, so
   * they are dropped from the parsed snapshot and would otherwise be excluded
   * from the targeted (by-known-id) refresh fetch. Transport remembers these IDs
   * so targeted refreshes keep re-reading the battery without a separate fetch.
   */
  batteryDeviceIds: string[];
};

// Role detection ONLY — by class or the canonical `homeBattery` energy role.
// Deliberately availability-agnostic: an offline battery is still a home battery,
// and its id must stay in the id set so targeted refreshes keep polling it (there
// is no periodic full refresh — the id set is how a battery is re-read). Whether
// it is AVAILABLE gates EMISSION, not membership (see `extractBatteryState`).
const isHomeBatteryDevice = (device: HomeyDeviceLike): boolean => (
  device.class === 'battery'
  // Check `energyObj` and `energy` INDEPENDENTLY: a present-but-incomplete
  // `energyObj` (e.g. `{}`) must not short-circuit away the `energy.homeBattery`
  // signal. Either declaring the canonical role marks a home battery.
  || asRecord(device.energyObj)?.homeBattery === true
  || asRecord(device.energy)?.homeBattery === true
);

const readCapabilityValue = (device: HomeyDeviceLike, capabilityId: string): unknown => {
  const caps = asRecord(device.capabilitiesObj);
  const capability = asRecord(caps?.[capabilityId]);
  if (!capability || !Object.prototype.hasOwnProperty.call(capability, 'value')) return undefined;
  return capability.value;
};

// Per-battery SoC, validated at the boundary: a finite number IN RANGE [0,100],
// else `null`. A driver bug returning -5 / 150 is malformed external input and
// must not surface an impossible SoC (mirrors `normalizeStateOfChargePercent`,
// the repo's codified SoC boundary rule). `null` makes the all-or-null aggregate
// drop, so one bad battery suppresses the SoC emission.
const readBatterySoc = (device: HomeyDeviceLike): number | null => (
  normalizeStateOfChargePercent(readCapabilityValue(device, 'measure_battery')) ?? null
);

// Per-battery power: finite signed watts, else `null`. No range bound — `+`
// charging / `−` discharging is unbounded by design.
const readBatteryPowerW = (device: HomeyDeviceLike): number | null => (
  toFiniteNumber(readCapabilityValue(device, 'measure_power'))
);

// Aggregate a per-battery field ALL-OR-NULL across the included batteries: reduce
// only when EVERY battery has a valid value. A partial subset is `null` (absent),
// never a silently understated sum/mean — a missing/invalid term must not drop a
// charging contribution and flip the reported direction.
const aggregateAllOrNull = (
  values: readonly (number | null)[],
  reduce: (present: readonly number[]) => number,
): number | null => (
  values.length > 0 && values.every((value) => value !== null)
    ? reduce(values as readonly number[])
    : null
);

export const extractBatteryState = (devices: readonly HomeyDeviceLike[]): BatteryStateAggregate => {
  // ID SET: every role-detected battery, INCLUDING offline ones — so targeted
  // refreshes keep polling them and they recover when back online.
  const batteries = devices.filter(isHomeBatteryDevice);
  const batteryDeviceIds = batteries.map((device) => device.id);

  // EMISSION SET: only AVAILABLE batteries contribute to the surfaced aggregate —
  // an offline device's retained caps are stale and must never be emitted.
  const availableBatteries = batteries.filter((device) => device.available !== false);
  if (availableBatteries.length === 0) {
    return { batterySoc: null, batteryPowerW: null, batteryDeviceCount: 0, batteryDeviceIds };
  }
  const batterySoc = aggregateAllOrNull(
    availableBatteries.map(readBatterySoc),
    (present) => present.reduce((sum, soc) => sum + soc, 0) / present.length,
  );
  const batteryPowerW = aggregateAllOrNull(
    availableBatteries.map(readBatteryPowerW),
    (present) => present.reduce((sum, power) => sum + power, 0),
  );
  return { batterySoc, batteryPowerW, batteryDeviceCount: availableBatteries.length, batteryDeviceIds };
};

export const extractLivePowerWattsByDeviceId = (liveReport: unknown): LiveDevicePowerWatts => {
  const report = asRecord(liveReport);
  if (!report || !Array.isArray(report.items)) return {};
  return Object.fromEntries(
    report.items.flatMap((rawItem) => {
      const item = asRecord(rawItem);
      if (!item || item.type !== 'device') return [];
      const deviceId = typeof item.id === 'string' ? item.id : null;
      if (!deviceId) return [];
      const values = asRecord(item.values);
      const watts = values?.W;
      if (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0) return [];
      return [[deviceId, watts] as const];
    }),
  );
};

export const hasPotentialHomeyEnergyEstimate = (device: HomeyDeviceLike): boolean => {
  const energy = asRecord(device.energyObj) || asRecord(device.energy);
  if (!energy) return false;

  const approx = asRecord(energy.approximation);
  const usageOnW = toFiniteNumber(approx?.usageOn);
  const usageOffW = toFiniteNumber(approx?.usageOff);
  if (usageOnW !== null && usageOffW !== null && usageOnW - usageOffW > 0) return true;
  if (usageOnW !== null && usageOnW > 0) return true;

  const energyW = toFiniteNumber(energy.W);
  return energyW !== null && energyW >= 0;
};
