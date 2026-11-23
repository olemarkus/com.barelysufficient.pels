import type { SettingsPort } from '../ports/homeyRuntime';
import { DEVICE_EXTERNAL_THERMOSTATS, MANAGED_DEVICES } from '../utils/settingsKeys';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { isAbsentSetting } from '../utils/settingsKeyList';
import {
  readExternalThermostats, type ExternalThermostatAssignment, type ExternalThermostatSettings,
} from '../../packages/shared-domain/src/settings/externalThermostats';

type ThermostatSettingsPort = Pick<SettingsPort, 'get' | 'getKeys'> & Partial<Pick<SettingsPort, 'set'>>;

const assignmentFor = (map: ExternalThermostatSettings, id: string) => Object.hasOwn(map, id) ? map[id] : undefined;

const sameAssignment = (
  first: ExternalThermostatAssignment | undefined, second: ExternalThermostatAssignment | undefined,
): boolean => first?.thermostatId === second?.thermostatId && first?.waitForManualOn === second?.waitForManualOn;

const donorIn = (map: ExternalThermostatSettings, id: string): boolean => (
  Object.values(map).some(({ thermostatId }) => thermostatId === id)
);

/** Owns accepted associations and the persistent manual-start guard used for handovers. */
export class DeviceExternalThermostatSettings {
  private accepted: ExternalThermostatSettings = {};
  private readonly revisions = new Map<string, number>();
  private readonly manualStartSince = new Map<string, number>();
  private associations: Readonly<Record<string, string>> = {};

  constructor(private readonly settings: ThermostatSettingsPort) {}

  get bindings(): Readonly<Record<string, string>> { return this.associations; }

  isDonor(id: string): boolean { return donorIn(this.accepted, id); }

  revision(id: string): number { return this.revisions.get(id) ?? 0; }

  needsManualStart(id: string): boolean {
    return assignmentFor(this.accepted, id)?.waitForManualOn === true;
  }

  reload(): void {
    const next = this.read();
    if (!next) return;
    const ids = new Set([...Object.keys(this.accepted), ...Object.keys(next)]);
    for (const id of ids) {
      const assignment = assignmentFor(next, id);
      if (sameAssignment(assignmentFor(this.accepted, id), assignment)) continue;
      this.revisions.set(id, this.revision(id) + 1);
      if (assignment?.waitForManualOn === true) this.manualStartSince.set(id, Date.now());
      else this.manualStartSince.delete(id);
    }
    this.accepted = next;
    this.associations = Object.fromEntries(
      Object.entries(next).flatMap(([id, { thermostatId }]) => thermostatId === null ? [] : [[id, thermostatId]]),
    );
  }

  isWriteCurrent(id: string): boolean {
    const persisted = this.read();
    if (persisted) {
      return sameAssignment(assignmentFor(this.accepted, id), assignmentFor(persisted, id))
        && this.isDonor(id) === donorIn(persisted, id);
    }
    return assignmentFor(this.accepted, id) === undefined && !this.isDonor(id) && !this.persistedMapMentions(id);
  }

  isTemperatureWriteCurrent(id: string): boolean {
    if (!this.isWriteCurrent(id)) return false;
    const donor = this.bindings[id];
    if (!donor) return false;
    try {
      const managed = this.settings.get(MANAGED_DEVICES);
      return isUnknownRecord(managed) && managed[id] === true && managed[donor] !== true;
    } catch {
      return false;
    }
  }

  allowsBinaryWrite(id: string, desired: boolean): boolean {
    if (!this.isWriteCurrent(id) || this.isDonor(id)) return false;
    const assignment = assignmentFor(this.accepted, id);
    return !assignment?.thermostatId && (!desired || assignment?.waitForManualOn !== true);
  }

  acceptManualStart(id: string, observedAtMs: number): void {
    const acceptedAtMs = this.manualStartSince.get(id);
    if (acceptedAtMs === undefined || observedAtMs <= acceptedAtMs) return;
    const persisted = this.read();
    const current = assignmentFor(this.accepted, id);
    if (!persisted || !current?.waitForManualOn || !sameAssignment(current, assignmentFor(persisted, id))) return;
    const otherEntries = Object.entries(persisted).filter(([key]) => key !== id);
    const next = current.thermostatId === null
      ? Object.fromEntries(otherEntries)
      : Object.fromEntries([...otherEntries, [id, { thermostatId: current.thermostatId }]]);
    try { this.settings.set?.(DEVICE_EXTERNAL_THERMOSTATS, next); } catch { /* Keep the guard active. */ }
  }

  private persistedMapMentions(id: string): boolean {
    try {
      const raw = this.settings.get(DEVICE_EXTERNAL_THERMOSTATS);
      return isUnknownRecord(raw) && (Object.hasOwn(raw, id)
        || Object.values(raw).some((value) => isUnknownRecord(value) && value.thermostatId === id));
    } catch {
      return false;
    }
  }

  private read(): ExternalThermostatSettings | undefined {
    try {
      const raw = this.settings.get(DEVICE_EXTERNAL_THERMOSTATS);
      const value = readExternalThermostats(raw);
      if (value) return value;
      if (isAbsentSetting(this.settings, DEVICE_EXTERNAL_THERMOSTATS, raw)) return {};
    } catch { /* A failed read doesn't remove accepted settings or grant write authority. */ }
    return undefined;
  }
}
