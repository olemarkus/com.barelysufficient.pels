/**
 * Main's passive heating observations: recorded at each accepted Main meter
 * sample, checkpointed to their own store (`heatingShadowStore.ts`) once a
 * minute, and read by the daily report. No fitting, planning or control reads
 * them, and collection does not wait for the daily report switch.
 *
 * The stored observations are read before the first sample is recorded, so a
 * restart continues the stored chronology. A store that cannot be read then
 * is read again at each checkpoint while collection carries on in memory, and
 * nothing is written until it answers: the stored history is then merged under
 * what this run collected (`mergeHeatingShadowHistory`). Homey often stops the
 * app without `onUninit`, so a stop loses at most the minute since the last
 * checkpoint; nothing is flushed at shutdown.
 */
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { SupportReportSection } from '../../packages/contracts/src/supportReport';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { incPerfCounter } from '../utils/perfCounters';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { recordHeatingShadow } from './heatingShadow';
import { observeHeatingShadowDevices } from './heatingShadowIngest';
import { mergeHeatingShadowHistory } from './heatingShadowMerge';
import { readHeatingShadowDaily } from './heatingShadowReport';
import { createDeferredHeatingShadowStore, type HeatingShadowStore } from './heatingShadowStore';
import type { HeatingShadowState } from './heatingShadowTypes';

const HEATING_SHADOW_CHECKPOINT_MS = 60_000;

const logger = getLogger('diagnostics/heating-shadow');

export class HeatingShadowCollector {
  private state: HeatingShadowState | undefined;
  /** Whether the stored observations were read; nothing is written before they are. */
  private hydrated = false;
  private checkpointAttemptAtMs = -Infinity;
  /** Repeated store failures are said once, until a read or write succeeds again. */
  private storeFailing = false;

  constructor(
    private readonly store: HeatingShadowStore,
    /** Main's devices, joined with their accepted observations. */
    private readonly getDevices: () => readonly DeviceSurfaces[],
    private readonly getThermalDirection: (deviceId: string) => ThermalDirection,
    private readonly getTimeZone: () => string,
    /** The held outdoor temperature; `undefined` when unavailable or stale. */
    private readonly getOutdoorTemperatureC: () => number | undefined,
  ) {}

  /** One accepted Main meter sample. Never throws: collection cannot interrupt ingest. */
  record(nowMs: number): void {
    // A clock set back is due at once, so it cannot hold checkpoints off until it catches up.
    const due = nowMs - this.checkpointAttemptAtMs >= HEATING_SHADOW_CHECKPOINT_MS
      || nowMs < this.checkpointAttemptAtMs;
    if (due) {
      this.checkpointAttemptAtMs = nowMs;
      if (!this.hydrated) this.tryStore('heating_shadow_read_failed', () => this.hydrate());
    }
    this.collect(nowMs);
    const { state } = this;
    if (due && this.hydrated && state) this.tryStore('heating_shadow_persist_failed', () => this.store.save(state));
  }

  /**
   * The latest retained completed day as a report section; `undefined` when
   * none was observed. Throws while the stored observations cannot be read.
   */
  readDaily(capturedAtMs: number): SupportReportSection | undefined {
    if (!this.hydrated) this.hydrate();
    return this.state ? readHeatingShadowDaily(this.state, capturedAtMs, this.getTimeZone()) : undefined;
  }

  private hydrate(): void {
    const stored = this.store.load();
    this.hydrated = true;
    if (stored === null) return;
    this.state = this.state === undefined ? stored : mergeHeatingShadowHistory(this.state, stored);
  }

  private collect(nowMs: number): void {
    try {
      const observed = observeHeatingShadowDevices(this.getDevices(), nowMs, this.getThermalDirection);
      if (observed.length === 0 && this.state === undefined) return;
      this.state = recordHeatingShadow(this.state, observed, nowMs, this.getOutdoorTemperatureC(), this.getTimeZone());
    } catch {
      incPerfCounter('heating_shadow_collection_failed_total');
    }
  }

  private tryStore(event: string, work: () => void): void {
    try {
      work();
      this.storeFailing = false;
    } catch (error) {
      if (!this.storeFailing) logger.error({ event, err: normalizeError(error) });
      this.storeFailing = true;
    }
  }
}

/** Main's collector, on the userdata database once it is open; built before it opens. */
export const createMainHeatingShadowCollector = (
  getDatabase: () => UserdataDatabase,
  getDevices: () => readonly DeviceSurfaces[],
  getThermalDirection: (deviceId: string) => ThermalDirection,
  getTimeZone: () => string,
  getOutdoorTemperatureC: () => number | undefined,
): HeatingShadowCollector => new HeatingShadowCollector(
  createDeferredHeatingShadowStore(getDatabase), getDevices, getThermalDirection, getTimeZone, getOutdoorTemperatureC,
);
