import type { ChargingPhaseReservation } from '../../packages/planner-types/src/chargingPhases';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { getLogger } from '../logging/logger';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

export const CHARGING_PHASE_RECORD_PREFIX = 'charging_phase_claim.';

type SwitchHistory = { switchesMs: readonly number[] };
export type ChargingPhaseRecord = SwitchHistory & (
  | { kind: 'free' }
  | { kind: 'held'; originalForceSingle: boolean; claimedAtMs: number;
      reservation: Omit<ChargingPhaseReservation, 'deviceId'> }
);

const logger = getLogger('chargingPhases/claims');

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isRecord = (value: unknown): value is ChargingPhaseRecord => {
  if (!isUnknownRecord(value) || !Array.isArray(value.switchesMs) || !value.switchesMs.every(finite)) return false;
  if (value.kind === 'free') return true;
  if (value.kind !== 'held' || typeof value.originalForceSingle !== 'boolean'
    || !finite(value.claimedAtMs)) return false;
  const reservation = value.reservation;
  if (!isUnknownRecord(reservation) || !finite(reservation.totalKw) || reservation.totalKw < 0
    || !isUnknownRecord(reservation.perPhaseKw)) return false;
  const phases = reservation.perPhaseKw;
  return ['L1', 'L2', 'L3'].every((phase) => finite(phases[phase]) && phases[phase] >= 0);
};

/** Per-device durable records preserve unrelated claims when one external read fails. */
export class ChargingPhaseClaimStore {
  private readonly records = new Map<string, ChargingPhaseRecord>();
  private readonly persistenceFailures = new Set<string>();
  private readonly unreadable = new Set<string>();
  private loaded = false;

  constructor(private readonly settings: SettingsPort) {}

  load(): boolean {
    if (this.loaded && this.unreadable.size === 0) return true;
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved') return false;
    for (const key of keys.keys) {
      if (!key.startsWith(CHARGING_PHASE_RECORD_PREFIX)) continue;
      const id = key.slice(CHARGING_PHASE_RECORD_PREFIX.length);
      if (this.loaded && !this.unreadable.has(id)) continue;
      try {
        const value = this.settings.get(key);
        if (!isRecord(value)) { this.unreadable.add(id); continue; }
        this.records.set(id, value);
        this.unreadable.delete(id);
      } catch { this.unreadable.add(id); }
    }
    this.loaded = true;
    return true;
  }

  canClaim(deviceId: string): boolean { return this.loaded && !this.unreadable.has(deviceId); }
  read(deviceId: string): ChargingPhaseRecord | undefined { return this.records.get(deviceId); }
  entries(): IterableIterator<[string, ChargingPhaseRecord]> { return this.records.entries(); }

  clearReservation(deviceId: string): boolean {
    const record = this.read(deviceId);
    if (record?.kind !== 'held') return true;
    return this.persistLifecycle(deviceId, () => this.write(deviceId,
      { ...record, reservation: { totalKw: 0, perPhaseKw: { L1: 0, L2: 0, L3: 0 } } }));
  }

  persistLifecycle(deviceId: string, write: () => void): boolean {
    try {
      write();
      this.persistenceFailures.delete(deviceId);
      return true;
    } catch (error) {
      if (!this.persistenceFailures.has(deviceId)) {
        this.persistenceFailures.add(deviceId);
        logger.error({ event: 'charging_phase_persistence_failed', deviceId, err: error });
      }
      return false;
    }
  }

  write(deviceId: string, record: ChargingPhaseRecord): void {
    // The settings write is synchronous: a failure must precede the physical command.
    this.settings.set(`${CHARGING_PHASE_RECORD_PREFIX}${deviceId}`, record);
    this.records.set(deviceId, record);
  }
}
