/**
 * Which meter each home reads, and where its reading goes: Main's selected
 * meter to Main's power pipeline, every sub-home's meter to its own bundle.
 *
 * The device transport reads meters, not homes (`DeviceTransport.readMeters`).
 * This is the one place a meter id is told apart as Main's or a sub-home's.
 */
import type {
  HomeMeterRequest,
  LiveMeterReadings,
  MainMeterRead,
  MeterPowerSample,
} from '../ports/homeMeterReadings';
import { getDebugEmitter } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { readMainMeterSelection, type MainMeterSelectionSettings } from './mainMeterSelection';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';

const emitDebug = getDebugEmitter('devices', 'devices');

/** The sub-homes' meters and their per-home routing (`HomeRuntimeRegistry`). */
export type SubHomeMeters = {
  getMeterDeviceIds(): readonly string[];
  routeMeterReadings(readings: Readonly<Record<string, number>>, nowMs: number): void;
};

export class HomeMeters {
  constructor(
    /** Where Main's meter selection is stored; read once per request. */
    private readonly settings: MainMeterSelectionSettings,
    /** Main's power pipeline. */
    private readonly recordMainSample: (sample: MeterPowerSample) => Promise<void>,
    /** The sub-homes, once their registry exists; none before that or after teardown. */
    private readonly getSubHomes: () => SubHomeMeters | undefined,
  ) {}

  /**
   * One poll's meters, captured now: Main's if a meter is selected, and each
   * live sub-home's. Main's meter is fixed with the request, so a selection
   * that changes mid-read cannot move this poll's reading to another meter;
   * the sub-homes route through the registry's bundles at routing time. A
   * caller that discards the poll discards every home's reading with it.
   */
  request(): HomeMeterRequest {
    const main = resolveMainMeterRead(readMainMeterSelection(this.settings));
    const subHomes = this.getSubHomes();
    const meterDeviceIds = [...new Set([
      ...main.meterDeviceIds,
      ...(subHomes?.getMeterDeviceIds() ?? []),
    ])];
    return {
      meterDeviceIds,
      record: async (readings) => {
        routeSubHomeReadings(subHomes, readings);
        const sample = main.sampleFrom(readings);
        if (sample !== null) await this.recordMainSample(sample);
      },
    };
  }
}

/**
 * Main's part of a meter read: which meter to request for the selection, and
 * the whole-home sample the readings make. The poll and the snapshot refresh
 * both read Main through this. A read that yields no sample says why, so a home
 * with no selected meter is as visible in the log as a silent one.
 */
export function resolveMainMeterRead(selection: MainMeterSelection): MainMeterRead {
  if (selection.state !== 'resolved') {
    return {
      meterDeviceIds: [],
      sampleFrom: () => {
        emitDebug({ event: 'main_meter_no_reading', reasonCode: 'not_selected', selectionState: selection.state });
        return null;
      },
    };
  }
  const { meterDeviceId } = selection;
  return {
    meterDeviceIds: [meterDeviceId],
    sampleFrom: (readings) => {
      const sample = readMeterSample(readings, meterDeviceId);
      if (sample === null) emitDebug({ event: 'main_meter_no_reading', reasonCode: 'no_reading', meterDeviceId });
      return sample;
    },
  };
}

/**
 * The whole-home sample one meter's reading makes, stamped with that meter and
 * carrying the report's generation; null when the meter produced no reading.
 */
export function readMeterSample(readings: LiveMeterReadings, meterDeviceId: string): MeterPowerSample | null {
  const powerW = readings.meterPowerW[meterDeviceId];
  if (powerW === undefined) return null;
  return readings.generationW === undefined
    ? { powerW, meterDeviceId }
    : { powerW, generationW: readings.generationW, meterDeviceId };
}

// A sub-home's routing failure must not cost Main its sample.
function routeSubHomeReadings(subHomes: SubHomeMeters | undefined, readings: LiveMeterReadings): void {
  if (subHomes === undefined || Object.keys(readings.meterPowerW).length === 0) return;
  try {
    subHomes.routeMeterReadings(readings.meterPowerW, Date.now());
  } catch (error) {
    emitDebug({ event: 'additional_meter_readings_dispatch_failed', error: normalizeError(error).message });
  }
}
