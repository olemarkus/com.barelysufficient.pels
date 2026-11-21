import type { CapabilityWrite } from '../nativeSteppedLoadWiring';
import type { TemperatureAdjustmentObserver } from '../temperatureAdjustmentObserver';
import { getCurrentContext, runWithContext } from '../../logging/alsContext';
import { isHomeyRequestTimeout } from '../../utils/errorUtils';
import type { OwnCapabilityWrite } from './ownCapabilityWrites';
import type { TransportSnapshotStore } from './transportSnapshotStore';

/** Associate a temperature attempt with its Homey transaction without changing how the write settles. */
export async function sendWithTemperatureWriteEvidence(
  temperature: TemperatureAdjustmentObserver,
  snapshots: Pick<TransportSnapshotStore, 'getSnapshotByDeviceId'>,
  deviceId: string,
  requested: CapabilityWrite,
  write: OwnCapabilityWrite,
  send: () => Promise<void>,
): Promise<void> {
  if (requested.capabilityId !== 'target_temperature' || typeof requested.value !== 'number') {
    await send();
    return;
  }

  const { transactionId } = write;
  const previousTarget = snapshots.getSnapshotByDeviceId(deviceId)?.temperature?.target.value;
  const command = temperature.recordCommand(deviceId, requested.value, Date.now());
  try {
    await runWithContext({ transactionId }, send);
  } catch (error) {
    const { targetCommandId } = getCurrentContext();
    if (isHomeyRequestTimeout(error) && typeof targetCommandId === 'string'
      && snapshots.getSnapshotByDeviceId(deviceId) !== undefined) {
      temperature.recordTimeout(
        deviceId, command, targetCommandId, transactionId, Date.now(), previousTarget !== command.value,
      );
    }
    throw error;
  }
}
