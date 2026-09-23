import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import type { Logger } from '../utils/types';
import type { RetainedPowerReading, RetainedPowerState, RetainedPowerStore } from './retainedPowerStore';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';

const moduleLogger = getLogger('device/retained-power');

/**
 * How often retained power is written. The retained value is a last-known
 * reading, so losing the last minute of changes to a crash costs nothing a
 * restart would notice; writing on every refresh would cost the flash.
 */
const RETAINED_POWER_SAVE_INTERVAL_MS = 60 * 1000;

/**
 * The transport's retained power readings across a restart — see
 * `retainedPowerStore.ts` for why.
 *
 * Constructed with the transport, before its first read: it builds the
 * transport's measured-power resolver with its meter anchors restored, and the
 * readings answer `restoredReading` for a
 * device the transport has no previous snapshot entry for, which is exactly the
 * first read after boot. Once a device has an entry, the snapshot carries its
 * retained reading as it always has, and the restored one is not consulted.
 */
export class RetainedPowerPersistence {
  /** The transport's measured-power resolver, its meter anchors already restored. */
  readonly resolver: DeviceMeasuredPowerResolver;
  private readonly restored: Map<string, RetainedPowerReading>;
  private lastSaveMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: RetainedPowerStore,
    logger: Logger,
    lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }>,
  ) {
    this.resolver = new DeviceMeasuredPowerResolver({ logger, lastPositiveMeasuredPowerKw });
    const state = loadOrStartEmpty(store);
    this.restored = new Map(state.readings);
    this.resolver.seedMeterAnchors(state.meterAnchors);
    moduleLogger.info({
      event: 'retained_power_restored',
      readingCount: state.readings.size,
      meterAnchorCount: state.meterAnchors.size,
    });
  }

  /** The reading this device had when the app last saved, if any. */
  restoredReading(deviceId: string): RetainedPowerReading | undefined {
    return this.restored.get(deviceId);
  }

  /**
   * Save what the committed snapshot retains, at most once per
   * `RETAINED_POWER_SAVE_INTERVAL_MS`. A failed write is logged and skipped: the
   * next save retries with the then-current state, and the in-memory retention
   * the transport runs on is untouched either way.
   */
  persist(snapshot: readonly TransportDeviceSnapshot[], nowMs: number): void {
    // A device in a committed snapshot has its own retained reading from now on;
    // a boot-time one must not answer a later parse that has no previous entry
    // for it (a device that dropped out and came back), because it is older.
    for (const device of snapshot) this.restored.delete(device.id);
    if (nowMs - this.lastSaveMs < RETAINED_POWER_SAVE_INTERVAL_MS) return;
    this.lastSaveMs = nowMs;
    const readings = new Map<string, RetainedPowerReading>();
    const presentIds = new Set<string>();
    for (const device of snapshot) {
      presentIds.add(device.id);
      const retained = toRetainedPowerReading(device);
      if (retained !== null) readings.set(device.id, retained);
    }
    try {
      this.store.save({ readings, meterAnchors: this.resolver.getMeterAnchors() }, presentIds, nowMs);
    } catch (error) {
      moduleLogger.error({ event: 'retained_power_save_failed', error: normalizeError(error).message });
    }
  }
}

/**
 * What a device's snapshot entry has worth keeping across a restart: a reading a
 * cumulative meter resolved (an interval average), which is the one the SDK
 * cannot reproduce on the first read after boot. A direct `measure_power`
 * reading is re-read at once, so it is not kept — which also keeps the writes
 * to devices whose meter windows actually move.
 */
const toRetainedPowerReading = (device: TransportDeviceSnapshot): RetainedPowerReading | null => {
  if (!hasObservedMeasuredPower(device) || device.measuredPowerReading?.kind !== 'interval_average') return null;
  return device.measuredPowerObservedAtMs === undefined
    ? { measuredPowerKw: device.measuredPowerKw }
    : { measuredPowerKw: device.measuredPowerKw, observedAtMs: device.measuredPowerObservedAtMs };
};

/**
 * The store holds a regenerable cache, so a load that fails is logged and the
 * transport starts with nothing restored — exactly the pre-persistence boot —
 * rather than failing to come up over a cache.
 */
const loadOrStartEmpty = (store: RetainedPowerStore): RetainedPowerState => {
  try {
    return store.load(Date.now());
  } catch (error) {
    moduleLogger.error({ event: 'retained_power_load_failed', error: normalizeError(error).message });
    return { readings: new Map(), meterAnchors: new Map() };
  }
};
