/**
 * Timed run of the hour's marginal on/off device (`notes/end-of-hour-mode.md`
 * § "Timed run of an on/off device").
 *
 * An hourly limit counts energy. When the house's gap under the hourly target
 * is smaller than the on/off device that could fill it, the device can still
 * run for part of the hour and stop in time. The ordinary capacity pace cannot
 * express that: it asks whether the house could hold its current draw until
 * `:00`, so a heater that may run for half the hour is held off until the
 * hour's unused energy pays for the whole rest of it, and is then cut by the
 * end-of-hour drain.
 *
 * This resolves, once per build and from the measurement alone (no stored
 * state), whether the marginal device may run now. The device restore would
 * start first, when it is an on/off device PELS holds off, may start if it then
 * gets at least `TIMED_RUN_MIN_START_MIN` before it has to stop; once running,
 * the device shedding would limit first keeps running until then. It has to
 * stop when the energy left covers only the rest of the house plus a reserve,
 * and before the drain. Every step also keeps the slow-response rule: the
 * draw, held unchanged to `:00`, leaves the protected half of the margin under
 * the hard cap. The answer is a raised capacity pace (`allowedKw`), so
 * shedding, restore admission, the grace period and the Overview read one
 * limit; at the stop the normal shedding lane limits the device in priority
 * order.
 */
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import { resolveCapacityMarginKWh } from '../power/capacityModel';
import { getDebugEmitter, getLogger, isDebugTopicEnabled } from '../logging/logger';
import { buildPlannedBinaryCommand } from './planExecutionProjection';
import { isMeteredPlanDevice } from './planMeteredDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { computeRestoreBufferKw } from './restore/accounting';
import { EOH_DRAIN_WINDOW_MIN, SHED_GRACE_MARGIN_FRACTION } from './planConstants';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';

/** The shortest run worth starting a device for. */
export const TIMED_RUN_MIN_START_MIN = 10;
/** How long a stopped device may keep drawing; its energy is reserved on top. */
export const TIMED_RUN_STOP_RESPONSE_MIN = 2;
/** A running device below this draw is not filling the gap (a satisfied thermostat). */
const TIMED_RUN_MIN_DRAW_KW = 0.1;
const HOUR_MS = 3_600_000;

export type CapacityTimedRun =
  | { kind: 'none' }
  | {
    /** `keep`: the device runs and may go on; `start`: it is held off and may start. */
    kind: 'keep' | 'start';
    deviceId: string;
    deviceName: string;
    deviceKw: number;
    /** When the device has to be off again for the hour to land on its target. */
    stopAtMs: number;
    /** The capacity pace this cycle decides against, above the ordinary pace. */
    allowedKw: number;
  };

export type CapacityTimedRunInput = {
  settings: CapacitySettings;
  /** The ordinary capacity pace (`computeDynamicSoftLimit`). */
  paceKw: number;
  /** The draw that, held to the end of the hour, would reach the hard cap (`computeShortfallThreshold`). */
  shortfallThresholdKw: number;
  usedKWh: number;
  budgetKWh: number;
  minutesRemaining: number;
  coverageComplete: boolean;
  drawKw: number;
  devices: readonly PlanInputDevice[];
  /** The devices the previous plan held off (`ShedDecisionHistory.lastPlannedShedIds`). */
  heldOffIds: ReadonlySet<string>;
  /** Devices a smart task holds off this cycle (`DeferredDecorationBundle.forceShedSet`). */
  forceShedIds: ReadonlySet<string>;
  nowMs: number;
};

type TimedRunDevice = PlanInputDevice & { currentDrawKw: number };

const isCommandable = (device: PlanInputDevice): boolean => device.control.managed && device.control.commandAuthority;

const isTimedRunDevice = (device: PlanInputDevice): device is TimedRunDevice => (
  isMeteredPlanDevice(device)
  && !isSteppedLoadDevice(device)
  && !device.isEvCharger
  && !device.isBatteryOrSolar
  && isCommandable(device)
);

/** Anything the shedding lane could limit now: a drawing device, or a battery. */
const isLimitableNow = (device: PlanInputDevice): boolean => isCommandable(device) && (
  device.isBatteryOrSolar
  || (isMeteredPlanDevice(device) && device.currentDrawKw >= TIMED_RUN_MIN_DRAW_KW)
);

/** The hour's energy facts a timed run is judged on, resolved once per build. */
type TimedRunHour = {
  input: CapacityTimedRunInput;
  runWindowMin: number;
  /** kWh left once the device stops, with the house at `baseKw` (reserve and stop taken off). */
  spareKWh: (baseKw: number, deviceKw: number) => number;
  /** The slow-response rule for a draw held unchanged to `:00`. */
  holdsHardCap: (heldDrawKw: number) => boolean;
  stopAt: (runHours: number) => number;
};

export function resolveCapacityTimedRun(input: CapacityTimedRunInput): CapacityTimedRun {
  const hour = resolveTimedRunHour(input);
  if (hour === null) return { kind: 'none' };
  return input.drawKw > input.paceKw ? resolveKeep(hour) : resolveStart(hour);
}

function resolveTimedRunHour(input: CapacityTimedRunInput): TimedRunHour | null {
  const { settings, minutesRemaining } = input;
  if (settings.periodMinutes !== 60 || !input.coverageComplete) return null;
  // The run must end before the drain, which keeps the next hour clean.
  const runWindowMin = minutesRemaining - EOH_DRAIN_WINDOW_MIN;
  if (runWindowMin <= 0) return null;
  const remainingHours = minutesRemaining / 60;
  const protectedKWh = resolveCapacityMarginKWh(settings) * SHED_GRACE_MARGIN_FRACTION;
  return {
    input,
    runWindowMin,
    // Room for another `margin * fraction` kW of background load for the rest of
    // the hour once the device is off, and for the stop to show on the meter.
    spareKWh: (baseKw, deviceKw) => (
      input.budgetKWh - input.usedKWh - protectedKWh * remainingHours
      - deviceKw * TIMED_RUN_STOP_RESPONSE_MIN / 60 - baseKw * remainingHours
    ),
    // The slow-response rule (`notes/slow-response-control.md`): a draw is held
    // past the pace only while, held unchanged to the end of the hour, it still
    // leaves the protected half of the margin under the hard cap. So even a
    // stop that never lands keeps the hard cap as an ordinary cut would.
    holdsHardCap: (heldDrawKw) => (input.shortfallThresholdKw - heldDrawKw) * remainingHours >= protectedKWh,
    stopAt: (runHours) => input.nowMs + Math.min(runHours, runWindowMin / 60) * HOUR_MS,
  };
}

/** Over the pace: the running device shedding would limit first goes on until its stop. */
function resolveKeep(hour: TimedRunHour): CapacityTimedRun {
  const { input } = hour;
  // Only the device the shedding lane would limit first: running on while a
  // lower-ranked device draws over the pace would invert the priority order.
  const device = pickLowestPriority(input.devices.filter(isLimitableNow));
  if (device === null || !isTimedRunDevice(device) || device.currentState !== 'on') return { kind: 'none' };
  // A limit the last plan decided stands while its command lands; only `start` reopens it.
  if (input.heldOffIds.has(device.id)) return { kind: 'none' };
  const deviceKw = device.currentDrawKw;
  // A device reading above the whole house's is two samples out of step, not a margin;
  // and the device is the margin only when limiting it alone would answer the pace.
  if (deviceKw > input.drawKw || input.drawKw - deviceKw > input.paceKw) return { kind: 'none' };
  if (!hour.holdsHardCap(input.drawKw)) return { kind: 'none' };
  const runHours = hour.spareKWh(input.drawKw - deviceKw, deviceKw) / deviceKw;
  if (runHours <= 0) return { kind: 'none' };
  return timedRun('keep', device, deviceKw, hour.stopAt(runHours), input.drawKw);
}

/** Under the pace: the held-off device restore would start first may start for a run. */
function resolveStart(hour: TimedRunHour): CapacityTimedRun {
  const { input } = hour;
  // Only the device restore would start first, so the room goes to it.
  const heldOff = input.devices.filter((device) => (
    isCommandable(device) && input.heldOffIds.has(device.id) && !input.forceShedIds.has(device.id)
  ));
  const device = pickHighestPriority(heldOff);
  if (device === null || !isTimedRunDevice(device) || device.currentState !== 'off') return { kind: 'none' };
  const deviceKw = device.residualKw.restore.kw;
  if (deviceKw < TIMED_RUN_MIN_DRAW_KW) return { kind: 'none' };
  const runHours = hour.spareKWh(input.drawKw, deviceKw) / deviceKw;
  if (Math.min(runHours * 60, hour.runWindowMin) < TIMED_RUN_MIN_START_MIN) return { kind: 'none' };
  const allowedKw = input.drawKw + deviceKw + computeRestoreBufferKw(deviceKw);
  // Judged with the restore buffer on top, so the keep that follows, on a
  // reading a few tens of watts higher, still passes: without that margin a
  // start that only just fits is cut again a minute later.
  if (allowedKw <= input.paceKw || !hour.holdsHardCap(allowedKw)) return { kind: 'none' };
  return timedRun('start', device, deviceKw, hour.stopAt(runHours), allowedKw);
}

function timedRun(
  kind: 'keep' | 'start',
  device: PlanInputDevice,
  deviceKw: number,
  stopAtMs: number,
  allowedKw: number,
): CapacityTimedRun {
  return { kind, deviceId: device.id, deviceName: device.name, deviceKw, stopAtMs, allowedKw };
}

// Shedding limits the highest priority number first; restore starts the lowest.
function pickLowestPriority<T extends PlanInputDevice>(devices: readonly T[]): T | null {
  let worst: T | null = null;
  for (const device of devices) if (worst === null || device.priority > worst.priority) worst = device;
  return worst;
}

function pickHighestPriority<T extends PlanInputDevice>(devices: readonly T[]): T | null {
  let best: T | null = null;
  for (const device of devices) if (best === null || device.priority < best.priority) best = device;
  return best;
}

const emitTimedRunDebug = getDebugEmitter('plan', 'plan');

/** Tracks timed-run decisions supported by final controlled ON intent across builds. */
export class CapacityTimedRunLog {
  private readonly logger = getLogger('plan/capacity-timed-run');

  private deviceId: string | null = null;

  private eligibleStartSignature: string | null = null;

  record(run: CapacityTimedRun, devices: readonly DevicePlanDevice[]): void {
    const device = run.kind === 'none' ? undefined : devices.find((item) => item.id === run.deviceId);
    const command = device ? buildPlannedBinaryCommand(device) : undefined;
    const plannedOn = command?.source === 'controlled' && command.desiredOn;
    this.recordEligibility(run, plannedOn, device);

    const activeRun = plannedOn ? run : { kind: 'none' } as const;
    const change = describeTimedRunChange(this.deviceId, activeRun);
    if (change !== null) this.logger.info(change);
    this.deviceId = activeRun.kind === 'none' ? null : activeRun.deviceId;
  }

  private recordEligibility(run: CapacityTimedRun, plannedOn: boolean, device: DevicePlanDevice | undefined): void {
    if (run.kind !== 'start' || !isDebugTopicEnabled('plan')) {
      this.eligibleStartSignature = null;
      return;
    }
    const reasonCode = device?.reason?.code;
    const signature = `${run.deviceId}|${plannedOn}|${reasonCode ?? ''}`;
    if (signature === this.eligibleStartSignature) return;
    this.eligibleStartSignature = signature;
    emitTimedRunDebug({ event: 'capacity_timed_run_start_eligible', ...run, plannedOn, reasonCode });
  }
}

/** The info line for a transition in the final timed-run decision. */
export function describeTimedRunChange(
  previousDeviceId: string | null,
  run: CapacityTimedRun,
): Record<string, unknown> | null {
  const deviceId = run.kind === 'none' ? null : run.deviceId;
  if (deviceId === previousDeviceId) return null;
  if (run.kind === 'none') return { event: 'capacity_timed_run_ended', deviceId: previousDeviceId };
  return {
    event: 'capacity_timed_run_started',
    kind: run.kind,
    deviceId: run.deviceId,
    deviceName: run.deviceName,
    deviceKw: run.deviceKw,
    stopAtMs: run.stopAtMs,
    allowedKw: run.allowedKw,
  };
}
