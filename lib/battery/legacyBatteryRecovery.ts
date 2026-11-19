import type { BatteryRecovery, BatteryRecoveryRequest } from '../../packages/contracts/src/batteryRecovery';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { ApiRequestError } from '../utils/apiRequestError';
import type { BatteryControlDeviceReads } from '../ports/batteryControlOwner';
import type { StorageActuation } from '../ports/storageCommand';
import { getLogger } from '../logging/logger';
import type { BatteryClaimRecord, BatteryClaimStore } from './batteryClaimStore';
import type { BatteryManagedSettings } from './batteryControlSettings';
import type { PendingHandBacks, ReleaseReason } from './pendingHandBacks';

function parseBatteryRecoveryRequest(body: unknown): BatteryRecoveryRequest {
  if (isUnknownRecord(body) && typeof body.claimedAtMs === 'number' && Number.isFinite(body.claimedAtMs)) {
    const { claimedAtMs } = body;
    if (body.action === 'acknowledge') return { action: 'acknowledge', claimedAtMs };
    if (body.action === 'hand_back' && typeof body.targetId === 'string' && body.targetId.trim().length > 0) {
      return { action: 'hand_back', claimedAtMs, targetId: body.targetId };
    }
  }
  throw new ApiRequestError('Open the battery page again and confirm its recovery.');
}

const logger = getLogger('battery');
const RECOVERY_CHANGED_MESSAGE = 'Battery recovery has changed. Refresh the device page and try again.';

/** Explicit hand-back for old app-action claims with no recorded target. */
export class LegacyBatteryRecovery {
  private readonly running = new Set<string>();

  constructor(
    private readonly devices: BatteryControlDeviceReads,
    private readonly managed: BatteryManagedSettings,
    private readonly actuation: StorageActuation,
    private readonly store: BatteryClaimStore,
  ) {}

  isRunning(deviceId: string): boolean { return this.running.has(deviceId); }

  admitAutoRelease(deviceId: string, pending: PendingHandBacks, reason: ReleaseReason): boolean {
    const target = this.devices.batteryAppActions.readLegacyTarget(deviceId);
    if (target.kind === 'resolved') return true;
    if (target.kind === 'confirmation_required') {
      pending.awaitOwner(deviceId, reason);
    } else {
      pending.scheduleRetry(deviceId, reason, { kind: 'legacy_target_unavailable', reasonCode: target.reasonCode });
    }
    return false;
  }

  read(deviceId: string, record: BatteryClaimRecord | undefined): BatteryRecovery | undefined {
    if (record?.kind !== 'legacy_app_actions') return undefined;
    const target = this.devices.batteryAppActions.readLegacyTarget(deviceId);
    return target.kind === 'confirmation_required'
      ? { claimedAtMs: record.claimedAtMs, candidates: target.candidates } : undefined;
  }

  /** The caller holds the battery owner's per-device write queue for this operation. */
  async complete(
    deviceId: string,
    body: unknown,
    records: ReadonlyMap<string, BatteryClaimRecord>,
    onRecordRemoved: () => void,
  ): Promise<void> {
    const request = parseBatteryRecoveryRequest(body);
    const record = records.get(deviceId);
    const recovery = this.read(deviceId, record);
    if (recovery?.claimedAtMs !== request.claimedAtMs) throw new Error(RECOVERY_CHANGED_MESSAGE);
    this.requireManagedOff(deviceId);
    this.running.add(deviceId);
    try {
      if (request.action === 'hand_back') {
        if (!recovery.candidates.some(({ id }) => id === request.targetId)) {
          throw new Error('The selected plant is unavailable. Check the Homey API key and refresh this page.');
        }
        const otherClaim = [...records.values()].some((record) => (
          record.kind === 'app_actions' && record.target.deviceId === request.targetId
        ));
        if (otherClaim) {
          throw new Error('Another battery claim still holds this plant. Wait for PELS to hand it back.');
        }
        await this.handBack(deviceId, request.targetId);
        if (records.get(deviceId) !== record) throw new Error(RECOVERY_CHANGED_MESSAGE);
        this.requireManagedOff(deviceId);
      }
      if (!this.store.remove(deviceId)) {
        throw new Error('PELS could not save that the battery was restored. Try again.');
      }
      onRecordRemoved();
      logger.info({ event: 'battery_legacy_claim_recovered', deviceId, action: request.action });
    } finally {
      this.running.delete(deviceId);
    }
  }

  private requireManagedOff(deviceId: string): void {
    const current = this.managed.readStored();
    const applied = this.managed.read();
    if (current.status !== 'resolved' || applied.status !== 'resolved') {
      throw new Error('Battery management settings could not be read. Try again.');
    }
    if (current.devices[deviceId] !== false || applied.devices[deviceId] !== false) {
      throw new Error('Turn off Managed by PELS before restoring this battery.');
    }
  }

  private async handBack(deviceId: string, targetId: string): Promise<void> {
    const result = await this.actuation.apply({
      kind: 'storage_release', deviceId, handBack: 'confirmed_legacy_app_actions', targetId,
    });
    if (!result.requested) throw new Error('PELS could not run the battery hand-back.');
  }
}
