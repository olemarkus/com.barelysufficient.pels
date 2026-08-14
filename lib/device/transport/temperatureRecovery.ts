import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import type { TransportContext } from './transportContext';
import { TARGET_TEMPERATURE_CAPABILITY_ID } from './temperatureObservation';

const moduleLogger = getLogger('device/transport');
type TemperatureRecoveryState = {
  pendingDeviceIds: Set<string>;
  refreshInFlightDeviceIds: Set<string>;
};

const temperatureRecoveryStateByOwner = new WeakMap<object, TemperatureRecoveryState>();

export function requestTemperatureRecovery(ctx: TransportContext, deviceId: string): void {
  const state = getTemperatureRecoveryState(ctx.owner);
  state.pendingDeviceIds.add(deviceId);
  if (state.refreshInFlightDeviceIds.has(deviceId)) return;
  state.refreshInFlightDeviceIds.add(deviceId);
  void ctx.refreshSnapshot({ targetedRefresh: true })
    .catch((error: unknown) => {
      moduleLogger.error({
        event: 'temperature_observation_recovery_failed',
        deviceId,
        err: normalizeError(error),
      });
    })
    .finally(() => {
      state.refreshInFlightDeviceIds.delete(deviceId);
    });
}

export function completePendingTemperatureRecoveriesAfterRefresh(ctx: TransportContext): void {
  const state = getTemperatureRecoveryState(ctx.owner);
  for (const deviceId of state.pendingDeviceIds) {
    const recovered = ctx.latestSnapshotById.get(deviceId);
    if (!recovered?.temperature) continue;
    state.pendingDeviceIds.delete(deviceId);
    dispatchRecoveredTemperature(ctx, deviceId, recovered.name);
  }
}

export function getPendingTemperatureRecoveryDeviceIds(ctx: TransportContext): string[] {
  return [...getTemperatureRecoveryState(ctx.owner).pendingDeviceIds];
}

function dispatchRecoveredTemperature(ctx: TransportContext, deviceId: string, deviceName: string): void {
  const cursor = ctx.nextObservationCursor(deviceId);
  ctx.dispatchPlanReconcile({
    deviceId,
    ...cursor,
    name: deviceName,
    capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
  });
}

function getTemperatureRecoveryState(owner: object): TemperatureRecoveryState {
  const existing = temperatureRecoveryStateByOwner.get(owner);
  if (existing) return existing;
  const created: TemperatureRecoveryState = {
    pendingDeviceIds: new Set(),
    refreshInFlightDeviceIds: new Set(),
  };
  temperatureRecoveryStateByOwner.set(owner, created);
  return created;
}
