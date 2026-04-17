import type { HeadroomCardState, PlanEngineState } from './planState';
import { isFiniteNumber } from '../utils/appTypeGuards';

export { isFiniteNumber };

export type HeadroomCardCooldownSource = 'step_down' | 'pels_shed' | 'pels_restore';
export type HeadroomDeviceKwSource = 'expectedPowerKw' | 'powerKw' | 'measuredPowerKw' | 'fallback_zero';
export type ResolvedHeadroomDeviceKw = { kw: number; source: HeadroomDeviceKwSource };

export type HeadroomCardDeviceLike = {
  id: string;
  name: string;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  currentOn: boolean;
  currentState?: string;
  available?: boolean;
};

export type HeadroomCooldownCandidate = {
  source: HeadroomCardCooldownSource;
  remainingSec: number;
  expiresAtMs: number;
  startMs: number;
  dropFromKw: number | null;
  dropToKw: number | null;
};

export const ensureHeadroomEntry = (
  state: PlanEngineState,
  deviceId: string,
): HeadroomCardState => {
  const cards = state.headroomCardByDevice;
  if (!cards[deviceId]) {
    cards[deviceId] = {};
  }
  return cards[deviceId];
};

export const updateHeadroomCardLastObserved = (
  state: PlanEngineState,
  deviceId: string,
  trackedKw: number,
  trackedKwSource: HeadroomDeviceKwSource,
  deviceName?: string,
): void => {
  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastObservedKw = trackedKw;
  entry.lastObservedKwSource = trackedKwSource;
  if (deviceName) {
    entry.deviceName = deviceName;
  }
};

export const resolveHeadroomDeviceName = (params: {
  state: PlanEngineState;
  deviceId: string;
  device?: Pick<HeadroomCardDeviceLike, 'name'>;
  deviceName?: string;
}): string | undefined => (
  params.device?.name
  ?? params.deviceName
  ?? params.state.headroomCardByDevice[params.deviceId]?.deviceName
);

export const resolveTrackedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'expectedPowerKw' | 'powerKw'>,
): ResolvedHeadroomDeviceKw => {
  if (isFiniteNumber(device.expectedPowerKw)) return { kw: device.expectedPowerKw, source: 'expectedPowerKw' };
  if (isFiniteNumber(device.powerKw)) return { kw: device.powerKw, source: 'powerKw' };
  return { kw: 0, source: 'fallback_zero' };
};

export const resolveObservedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'measuredPowerKw' | 'powerKw'>,
): ResolvedHeadroomDeviceKw => {
  if (isFiniteNumber(device.measuredPowerKw)) return { kw: device.measuredPowerKw, source: 'measuredPowerKw' };
  if (isFiniteNumber(device.powerKw)) return { kw: device.powerKw, source: 'powerKw' };
  return { kw: 0, source: 'fallback_zero' };
};
