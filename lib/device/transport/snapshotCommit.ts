import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { DeviceConfigurationStore } from '../deviceConfiguration';
import type { RetainedPowerPersistence } from '../retainedPowerPersistence';
import type { BinarySettleEvidenceService } from './binarySettleEvidence';
import type { TransportSnapshotStore } from './transportSnapshotStore';

/** Applies the side effects that must move together when a snapshot is accepted. */
export class SnapshotCommit {
  constructor(
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly configuration: DeviceConfigurationStore,
    private readonly binaryEvidence: BinarySettleEvidenceService,
    private readonly retainedPower: RetainedPowerPersistence,
  ) {}

  commit(snapshot: TransportDeviceSnapshot[]): void {
    this.snapshotStore.replaceSnapshot(snapshot);
    this.configuration.replace(snapshot);
    this.binaryEvidence.reconcileWithSnapshot(snapshot);
    this.retainedPower.persist(snapshot, Date.now());
  }
}
