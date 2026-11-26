/**
 * Does a device draw well above the figure PELS plans it with?
 *
 * PELS reserves a device's figure each time it turns the device back on, so a
 * figure set too low lets a restore run the home past its limit. The figure can
 * be wrong whatever its source: typed by the owner, set by a Flow, the device's
 * own load setting, Homey's energy information, or the device's own reading
 * (some apps publish a configured load as `measure_power`, and a meter can
 * read low for how it is wired). So the check does not trust any of them.
 *
 * - An on/off device is checked against the home meter: how far the
 *   whole-home reading fell a minute after PELS switched it off with nothing
 *   else decided around it (`lib/ports/soleSwitchOffFalls.ts`). Those falls
 *   are kept per device for {@link FALL_WINDOW_MS}. Unrelated load moves the
 *   sum in the same minute, so a single fall proves nothing: the check needs
 *   {@link MIN_AGREEING_FALLS} falls that agree with each other, and compares
 *   their median with the figure.
 * - A stepped device is checked against its own highest reading (the learned
 *   peak, `devicePowerPeak.ts`): a highest level far below what the device has
 *   drawn makes every restore of it too small.
 *
 * Chargers and batteries are left out: the car or the battery decides their
 * draw. The answer only informs the owner (a recommendation in the settings UI);
 * it never changes what PELS plans with.
 */
import type { PowerFigureCheck, PowerFigureKind } from '../../packages/contracts/src/powerFigureCheck';
import type { SteppedLoadDescriptorProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { getSteppedLoadHighestStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { getLogger } from '../logging/logger';
import type { SoleSwitchOffFall, SoleSwitchOffFallRecording } from '../ports/soleSwitchOffFalls';
import { normalizeError } from '../utils/errorUtils';
import { learnedPeakForSource, resolveLearnedPeakKw } from './devicePowerPeak';
import {
  createHomeMeterFallRepository,
  type HomeMeterFall,
  type HomeMeterFallRepository,
  type HomeMeterFallsByDeviceId,
} from './homeMeterFallStore';
import type { UserdataDatabase } from '../store/userdataDatabase';
import type { DeviceTransportPowerState } from './transport/transportTypes';

const logger = getLogger('device/power-figure-check');

/** How long a fall counts: as long as a learned peak stands without being matched. */
export const FALL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** The newest falls kept per device; older ones add nothing a busy device has not repeated. */
export const MAX_FALLS_PER_DEVICE = 12;
/** Falls that must agree before the home meter's figure counts. */
export const MIN_AGREEING_FALLS = 5;
/** Falls agree when they lie within 15 % either side of one figure. */
const AGREEING_FALL_SPAN = 1.15 / 0.85;
/** How far above the figure the measured draw must be, as a ratio and in kW. */
export const MIN_MEASURED_RATIO = 1.5;
export const MIN_MEASURED_GAP_KW = 0.4;

/** One device's check as a diagnostics report lists it. */
export type PowerFigureCheckEntry = PowerFigureCheck & { deviceId: string; deviceName: string };

/** The device as the check reads it: the figure PELS plans with, its class, and its levels if stepped. */
export type PowerFigureCheckDevice = Pick<
  TargetDeviceSnapshot, 'id' | 'expectedPowerKw' | 'expectedPowerSource' | 'isEvCharger' | 'isBatteryOrSolar'
> & SteppedLoadDescriptorProbe;

/** The middle value, or the mean of the middle two, of an ascending non-empty list. */
const median = (sorted: readonly number[]): number => {
  const middle = sorted.slice(Math.floor((sorted.length - 1) / 2), Math.floor(sorted.length / 2) + 1);
  return middle.reduce((sum, kw) => sum + kw, 0) / middle.length;
};

/**
 * The median of the largest group of falls that agree with each other, or
 * `null` when no group reaches {@link MIN_AGREEING_FALLS}. Of two groups the
 * same size, the higher one: a fall shrinks when unrelated load rises in the
 * same minute far more often than it grows.
 */
export const resolveAgreeingFallKw = (falls: readonly HomeMeterFall[]): number | null => {
  const values = falls.map((fall) => fall.fallKw).filter((kw) => kw > 0).sort((a, b) => a - b);
  let best: readonly number[] = [];
  for (const [start, lowest] of values.entries()) {
    const group = values.slice(start).filter((kw) => kw <= lowest * AGREEING_FALL_SPAN);
    if (group.length >= best.length) best = group;
  }
  return best.length >= MIN_AGREEING_FALLS ? median(best) : null;
};

const isWellAbove = (measuredKw: number, figureKw: number): boolean => (
  measuredKw >= figureKw * MIN_MEASURED_RATIO && measuredKw - figureKw >= MIN_MEASURED_GAP_KW
);

const resolveFigureKind = (
  device: PowerFigureCheckDevice,
  powerState: DeviceTransportPowerState,
): PowerFigureKind | null => {
  switch (device.expectedPowerSource) {
    case 'manual':
      return powerState.expectedPowerKwOverrides[device.id]?.origin === 'flow' ? 'flow' : 'typed';
    case 'load-setting':
      return 'load_setting';
    case 'measured-peak':
      return 'device_reading';
    case 'homey-energy':
      return 'homey_energy';
    case 'default':
      return 'default';
    default:
      return null;
  }
};

/**
 * The check for one device, or `undefined` when PELS has no reason to doubt
 * its figure: not enough evidence, evidence that agrees, or a device the check
 * leaves out.
 */
export const resolvePowerFigureCheck = (
  device: PowerFigureCheckDevice,
  falls: readonly HomeMeterFall[],
  powerState: DeviceTransportPowerState,
  nowMs: number,
  sourceDeviceId = device.id,
): PowerFigureCheck | undefined => {
  if (device.isEvCharger || device.isBatteryOrSolar) return undefined;
  if (isSteppedLoadSnapshot(device)) {
    const highest = getSteppedLoadHighestStep(device.steppedLoadProfile);
    const peak = learnedPeakForSource(powerState.lastKnownPowerKw[device.id], device.id, sourceDeviceId);
    const peakKw = resolveLearnedPeakKw(peak, nowMs);
    if (!highest || peakKw === null) return undefined;
    const figureKw = highest.planningPowerW / 1000;
    return isWellAbove(peakKw, figureKw) ? { measuredKw: peakKw, figureKw, figure: 'highest_level' } : undefined;
  }
  const figure = resolveFigureKind(device, powerState);
  const measuredKw = resolveAgreeingFallKw(falls.filter((fall) => nowMs - fall.atMs < FALL_WINDOW_MS));
  if (figure === null || measuredKw === null || !isWellAbove(measuredKw, device.expectedPowerKw)) return undefined;
  return { measuredKw, figureKw: device.expectedPowerKw, figure };
};

/**
 * The app's record of lone switch-offs and the check that reads it. Every
 * home's plan builder records into it (`SoleSwitchOffFallRecording`); the
 * settings UI's device list reads it. The falls are loaded from the userdata
 * database on first use; while that read fails nothing is recorded, so a
 * write cannot drop rows nobody has read.
 */
export class PowerFigureChecks implements SoleSwitchOffFallRecording {
  private falls: HomeMeterFallsByDeviceId | null = null;
  /** Said once per run of failures, not on every device-list read. */
  private readFailureLogged = false;

  constructor(
    private readonly getRepository: () => HomeMeterFallRepository,
    /** The app's manual figures and learned peaks, read at each check. */
    private readonly getPowerState: () => DeviceTransportPowerState,
    private readonly readExternalPowerSocketId?: (deviceId: string) => string | undefined,
  ) {}

  recordSoleSwitchOffFall(fall: SoleSwitchOffFall): void {
    const falls = this.loadFalls();
    if (falls === null) return;
    const kept = [...(falls.get(fall.deviceId) ?? []), { atMs: fall.decidedAtMs, fallKw: fall.fallKw }]
      .filter((entry) => fall.decidedAtMs - entry.atMs < FALL_WINDOW_MS)
      .slice(-MAX_FALLS_PER_DEVICE);
    const next = new Map(falls);
    next.set(fall.deviceId, kept);
    this.falls = next;
    try {
      this.getRepository().write(next);
    } catch (error) {
      logger.error({ event: 'home_meter_fall_write_failed', deviceId: fall.deviceId, err: normalizeError(error) });
    }
  }

  read(device: PowerFigureCheckDevice, nowMs: number): PowerFigureCheck | undefined {
    const falls = this.loadFalls();
    return resolvePowerFigureCheck(
      device, falls?.get(device.id) ?? [], this.getPowerState(), nowMs, this.readExternalPowerSocketId?.(device.id),
    );
  }

  /**
   * The devices among `devices` whose figure PELS doubts, with the check, for a
   * diagnostics report. Throws while the stored falls cannot be read, so the
   * report says the section is unavailable rather than that nothing is doubted.
   */
  readAll(
    devices: readonly (PowerFigureCheckDevice & { name: string })[],
    nowMs: number,
  ): PowerFigureCheckEntry[] {
    if (this.loadFalls() === null) throw new Error('The home meter falls could not be read.');
    return devices.flatMap((device) => {
      const check = this.read(device, nowMs);
      return check ? [{ deviceId: device.id, deviceName: device.name, ...check }] : [];
    });
  }

  private loadFalls(): HomeMeterFallsByDeviceId | null {
    if (this.falls !== null) return this.falls;
    try {
      this.falls = this.getRepository().read();
      this.readFailureLogged = false;
    } catch (error) {
      if (!this.readFailureLogged) logger.error({ event: 'home_meter_fall_read_failed', err: normalizeError(error) });
      this.readFailureLogged = true;
    }
    return this.falls;
  }
}

/**
 * The app's checks, on the falls table of whichever userdata database is open:
 * the repository is built on first use and rebuilt for a reopened database, so
 * a read outside the open window fails like every other userdata read.
 */
export const createPowerFigureChecks = (
  getDatabase: () => UserdataDatabase,
  getPowerState: () => DeviceTransportPowerState,
  readExternalPowerSocketId?: (deviceId: string) => string | undefined,
): PowerFigureChecks => {
  let opened: { database: UserdataDatabase; repository: HomeMeterFallRepository } | undefined;
  return new PowerFigureChecks(() => {
    const database = getDatabase();
    if (opened?.database !== database) opened = { database, repository: createHomeMeterFallRepository(database) };
    return opened.repository;
  }, getPowerState, readExternalPowerSocketId);
};
