import { isUnknownRecord } from '../recordGuards';

export type ExternalThermostatAssignment = Readonly<{
  thermostatId: string | null;
  waitForManualOn?: true;
}>;

export type ExternalThermostatSettings = Readonly<Record<string, ExternalThermostatAssignment>>;

function readAssignment(value: unknown): ExternalThermostatAssignment | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const { thermostatId, waitForManualOn } = value;
  if (waitForManualOn !== undefined && waitForManualOn !== true) return undefined;
  if (thermostatId === null && waitForManualOn === true) return { thermostatId, waitForManualOn };
  if (typeof thermostatId !== 'string' || thermostatId.trim() === '') return undefined;
  return waitForManualOn ? { thermostatId, waitForManualOn } : { thermostatId };
}

export function readExternalThermostats(value: unknown): ExternalThermostatSettings | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const entries = new Map<string, ExternalThermostatAssignment>();
  const sources = new Set<string>();
  for (const [id, raw] of Object.entries(value)) {
    const assignment = readAssignment(raw);
    if (!id.trim() || !assignment) return undefined;
    const { thermostatId } = assignment;
    if (thermostatId !== null) {
      if (Object.hasOwn(value, thermostatId) || sources.has(thermostatId)) return undefined;
      sources.add(thermostatId);
    }
    entries.set(id, assignment);
  }
  return Object.fromEntries(entries);
}
