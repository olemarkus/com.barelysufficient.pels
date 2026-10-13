import { vi } from 'vitest';
import {
  readObservedEvChargingState,
  readObservedStateOfCharge,
  readObservedTemperatureState,
  type ObservedDeviceReads,
} from '../../lib/observer/observedDeviceStateProjection';
import { resolveThermalDirection } from '../../lib/observer/thermalDirection';
import { hasLiveMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import type { ProjectedObservedDeviceState, ThermalDirection } from '../../packages/contracts/src/types';

/**
 * The observer's read port (`AppContext.observer`) for a fixture, answering
 * the way `ObservedDeviceStateProjection` answers over the records `getRecord`
 * supplies: the general read and the whole record are the same record, each
 * named read resolves it through the projection's own resolver, a device with
 * no record is heating with no live power reading, and the revision is 0.
 *
 * Every read is a spy, so a spec replaces one with `vi.mocked(...)` or
 * `vi.spyOn(ctx.observer, ...)`; `overrides` replace them up front.
 */
export const observedDeviceReadsDouble = (
  getRecord: (deviceId: string) => ProjectedObservedDeviceState | undefined = () => undefined,
  overrides: Partial<ObservedDeviceReads> = {},
): ObservedDeviceReads => ({
  getObservedState: vi.fn(getRecord),
  getObservedRecord: vi.fn(getRecord),
  getObservedStateOfCharge: vi.fn((deviceId: string) => readObservedStateOfCharge(getRecord(deviceId))),
  getObservedTemperature: vi.fn((deviceId: string) => readObservedTemperatureState(getRecord(deviceId))),
  getObservedEvChargingState: vi.fn((deviceId: string) => readObservedEvChargingState(getRecord(deviceId))),
  getThermalDirection: vi.fn((deviceId: string): ThermalDirection => {
    const record = getRecord(deviceId);
    return record === undefined ? 'heating' : resolveThermalDirection(record);
  }),
  isLiveMeasuredDraw: vi.fn((deviceId: string) => {
    const record = getRecord(deviceId);
    return record !== undefined && hasLiveMeasuredPower(record);
  }),
  getRevision: vi.fn(() => 0),
  ...overrides,
});
