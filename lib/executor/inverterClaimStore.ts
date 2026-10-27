import type { SettingsPort } from '../ports/homeyRuntime';
import type { InverterClaim } from '../ports/inverterControl';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

export const INVERTER_CLAIM_PREFIX = 'inverter_curtailment_claim.';

function parseMode(raw: unknown): InverterClaim['previousMode'] | null {
  if (!isUnknownRecord(raw)) return null;
  if (raw.kind === 'direct') return { kind: 'direct' };
  if ((raw.kind !== 'autonomous' && raw.kind !== 'controlled')
    || typeof raw.value !== 'string' || raw.value.length === 0
    || typeof raw.observedAtMs !== 'number' || !Number.isFinite(raw.observedAtMs)) return null;
  return { kind: raw.kind, value: raw.value, observedAtMs: raw.observedAtMs };
}

function parseClaim(raw: unknown): InverterClaim | null {
  if (!isUnknownRecord(raw)) return null;
  const { previousLimitW, claimedAtMs } = raw;
  const previousMode = parseMode(raw.previousMode);
  if (typeof previousLimitW !== 'number' || !Number.isFinite(previousLimitW) || previousLimitW < 0
    || previousMode === null
    || typeof claimedAtMs !== 'number' || !Number.isFinite(claimedAtMs)) return null;
  return { previousLimitW, previousMode, claimedAtMs };
}

/** Mission-critical hand-back state: one small Homey settings record per inverter. */
export class InverterClaimStore {
  constructor(private readonly settings: SettingsPort) {}

  readAll(): { records: ReadonlyMap<string, InverterClaim>; blocked: ReadonlySet<string> } | null {
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved') return null;
    const records = new Map<string, InverterClaim>();
    const blocked = new Set<string>();
    for (const key of keys.keys) {
      if (!key.startsWith(INVERTER_CLAIM_PREFIX)) continue;
      const id = key.slice(INVERTER_CLAIM_PREFIX.length);
      if (!id) continue;
      let record: InverterClaim | null;
      try { record = parseClaim(this.settings.get(key)); } catch { record = null; }
      if (record === null) blocked.add(id);
      else records.set(id, record);
    }
    return { records, blocked };
  }

  save(deviceId: string, claim: InverterClaim): void {
    this.settings.set(`${INVERTER_CLAIM_PREFIX}${deviceId}`, claim);
  }

  remove(deviceId: string): void {
    this.settings.unset(`${INVERTER_CLAIM_PREFIX}${deviceId}`);
  }
}
