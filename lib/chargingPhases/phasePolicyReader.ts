import type { ChargingPhaseSettingsMap } from '../../packages/contracts/src/chargingPhases';
import {
  CHARGING_PHASE_SETTINGS_KEY, isChargingPhaseSettingsMap,
} from '../../packages/shared-domain/src/settings/chargingPhases';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';

/** Settings failure retains accepted policy but never grants authority for new writes. */
export class ChargingPhasePolicyReader {
  values: ChargingPhaseSettingsMap = {};
  available = false;

  constructor(
    private readonly settings: SettingsPort,
    private readonly onChanged: (deviceId: string, nowMs: number) => void,
  ) {}

  refresh(nowMs: number): void {
    const keys = readSettingsKeyList(this.settings);
    this.available = false;
    if (keys.status !== 'resolved') return;
    if (!keys.keys.includes(CHARGING_PHASE_SETTINGS_KEY)) {
      this.accept({}, nowMs);
      return;
    }
    try {
      const value = this.settings.get(CHARGING_PHASE_SETTINGS_KEY);
      if (isChargingPhaseSettingsMap(value)) this.accept(value, nowMs);
    } catch { /* An unavailable read retains the last accepted policy. */ }
  }

  private accept(policy: ChargingPhaseSettingsMap, nowMs: number): void {
    for (const id of Object.keys(this.values)) {
      if (policy[id]?.mode !== this.values[id]?.mode) this.onChanged(id, nowMs);
    }
    this.values = policy;
    this.available = true;
  }
}
